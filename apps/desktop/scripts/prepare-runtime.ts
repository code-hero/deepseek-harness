/**
 * Assemble the target-platform Node runtime from the same tarballs used to
 * prove an npm release. This avoids workspace symlinks outside the bundle.
 */
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { releaseFamily, tarballName } from '../../../scripts/release/families.ts'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '../../..')
const desktop = resolve(scriptDir, '..')
const tarballs = join(desktop, '.runtime-tarballs')
const runtime = join(desktop, 'src-tauri', 'resources', 'runtime')
const downloads = join(desktop, '.runtime-downloads')

type RuntimeTarget = {
  platform: 'darwin' | 'win32'
  arch: 'arm64' | 'x64'
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const platform = argument('--platform') ?? process.platform
const arch = argument('--arch') ?? process.arch
if ((platform !== 'darwin' && platform !== 'win32') || (arch !== 'arm64' && arch !== 'x64')) {
  throw new Error(`unsupported desktop runtime target: ${platform}-${arch}`)
}
const target: RuntimeTarget = { platform, arch }
const isHostTarget = target.platform === process.platform && target.arch === process.arch

/** Resolve the verified native Koffi package from pnpm's virtual store. */
function workspaceKoffi(): string {
  const virtualStore = join(root, 'node_modules', '.pnpm')
  const directory = readdirSync(virtualStore).find(entry => entry.startsWith('koffi@'))
  if (directory === undefined) throw new Error('Koffi is absent from the workspace virtual store')
  return realpathSync(join(virtualStore, directory, 'node_modules', 'koffi'))
}

function koffiNativePackage(): string {
  return `@koromix/koffi-${target.platform}-${target.arch}`
}

/** Run one build tool and fail with its process status. */
function run(command: string, args: readonly string[], cwd: string = root): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
}

/** Pack a release family and return its local tarball dependency entries. */
function packFamily(id: 'dsh' | 'vendor'): Record<string, string> {
  const destination = join(tarballs, id)
  run('pnpm', ['exec', 'tsx', 'scripts/release/pack.ts', '--family', id, '--out', destination])

  const family = releaseFamily(id)
  const entries: Record<string, string> = {}
  for (const member of family.members(root)) {
    const tarball = join(destination, tarballName(member))
    if (!existsSync(tarball)) throw new Error(`missing packed artifact for ${member.name}: ${tarball}`)
    entries[member.name] = pathToFileURL(tarball).href
  }
  return entries
}

rmSync(tarballs, { recursive: true, force: true })
rmSync(runtime, { recursive: true, force: true })
mkdirSync(tarballs, { recursive: true })
mkdirSync(runtime, { recursive: true })

const dependencies = { ...packFamily('vendor'), ...packFamily('dsh') }
writeFileSync(join(runtime, 'package.json'), `${JSON.stringify({
  name: 'deepseek-harness-desktop-runtime',
  version: '0.0.0',
  private: true,
  dependencies,
}, null, 2)}\n`)

run('npm', [
  'install',
  '--ignore-scripts',
  '--include=optional',
  `--os=${target.platform}`,
  `--cpu=${target.arch}`,
  '--no-audit',
  '--no-fund',
  '--package-lock=false',
], runtime)

// Node 24 cannot build this Koffi release from source without a CMake setup.
// Bundle Koffi's matching optional native package instead.
const koffi = join(runtime, 'node_modules', 'koffi')
const koffiSource = workspaceKoffi()
const koffiVersion = JSON.parse(readFileSync(join(koffiSource, 'package.json'), 'utf8')).version as string
const nativePackage = koffiNativePackage()
const nativeDestination = join(runtime, 'node_modules', '@koromix', basename(nativePackage))
rmSync(koffi, { recursive: true, force: true })
rmSync(join(runtime, 'node_modules', '@koromix'), { recursive: true, force: true })
mkdirSync(join(runtime, 'node_modules', '@koromix'), { recursive: true })
cpSync(koffiSource, koffi, { recursive: true, dereference: true })
const nativeWorkspacePath = join(dirname(koffiSource), nativePackage)
if (isHostTarget && existsSync(nativeWorkspacePath)) {
  cpSync(realpathSync(nativeWorkspacePath), nativeDestination, { recursive: true, dereference: true })
} else {
  const nativeDownloads = join(downloads, 'koffi')
  mkdirSync(nativeDownloads, { recursive: true })
  run('npm', ['pack', `${nativePackage}@${koffiVersion}`, '--pack-destination', nativeDownloads])
  const archive = readdirSync(nativeDownloads)
    .filter(entry => entry.endsWith('.tgz'))
    .map(entry => join(nativeDownloads, entry))
    .sort((left, right) => right.localeCompare(left))[0]
  if (archive === undefined) throw new Error(`failed to download ${nativePackage}@${koffiVersion}`)
  mkdirSync(nativeDestination, { recursive: true })
  run('tar', ['-xf', archive, '-C', nativeDestination, '--strip-components=1'])
}
run(process.execPath, ['node_modules/@deepseek-ai/dsh-subprocess-local/scripts/ensure-spawn-helper.mjs'], runtime)

const node = join(runtime, target.platform === 'win32' ? 'node.exe' : 'node')
if (isHostTarget) {
  copyFileSync(process.execPath, node)
  chmodSync(node, 0o755)
} else if (target.platform === 'win32') {
  const nodeVersion = process.versions.node
  const nodeRelease = `node-v${nodeVersion}-win-${target.arch}`
  const archive = join(downloads, `${nodeRelease}.zip`)
  const extracted = join(downloads, nodeRelease)
  mkdirSync(downloads, { recursive: true })
  if (!existsSync(archive)) {
    run('curl', ['--fail', '--location', '--retry', '3', '--output', archive, `https://nodejs.org/dist/v${nodeVersion}/${nodeRelease}.zip`])
  }
  rmSync(extracted, { recursive: true, force: true })
  mkdirSync(extracted, { recursive: true })
  run('tar', ['-xf', archive, '-C', extracted])
  const downloadedNode = join(extracted, nodeRelease, 'node.exe')
  if (!existsSync(downloadedNode)) throw new Error(`downloaded Node executable missing: ${downloadedNode}`)
  copyFileSync(downloadedNode, node)
} else {
  throw new Error(`cannot prepare a ${target.platform}-${target.arch} runtime from ${process.platform}-${process.arch}`)
}

const entry = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (isHostTarget) {
  run(node, [entry, '--version'], runtime)
} else if (readFileSync(node).subarray(0, 2).toString('ascii') !== 'MZ') {
  throw new Error(`expected a Windows PE executable at ${node}`)
}

const packageCount = readdirSync(join(runtime, 'node_modules', '@deepseek-ai')).length
console.log(`desktop runtime: ${String(packageCount)} DeepSeek packages ready for ${target.platform}-${target.arch} at ${runtime}`)
