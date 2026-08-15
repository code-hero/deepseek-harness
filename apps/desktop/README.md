# DeepSeek Harness Desktop

This Tauri shell packages the DeepSeek Harness web profile with its Node.js runtime. The runtime is assembled during each platform build and is not committed.

Run `pnpm run build` from the repository root before preparing a desktop bundle. Then run one of these commands from the repository root:

```sh
pnpm --dir apps/desktop run bundle:macos
pnpm --dir apps/desktop run bundle:windows
```

The Windows installer is built on the `desktop-windows.yml` GitHub Actions workflow because Tauri's NSIS target must run natively on Windows. Its artifact is uploaded as `DeepSeek-Harness-Windows-x64`.
