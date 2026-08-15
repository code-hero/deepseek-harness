use std::{
    env,
    fs::{create_dir_all, File},
    io,
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread::sleep,
    time::Duration,
};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct HarnessProcess(Mutex<Option<Child>>);

fn reserve_loopback_port() -> io::Result<u16> {
    TcpListener::bind("127.0.0.1:0")?
        .local_addr()
        .map(|address| address.port())
}

fn wait_for_server(port: u16) -> io::Result<()> {
    let address = format!("127.0.0.1:{port}");
    for _ in 0..100 {
        if TcpStream::connect_timeout(
            &address.parse().expect("valid loopback address"),
            Duration::from_millis(100),
        )
        .is_ok()
        {
            sleep(Duration::from_millis(150));
            return Ok(());
        }
        sleep(Duration::from_millis(100));
    }
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "DeepSeek Harness server did not start within 10 seconds",
    ))
}

fn app_data_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let directory = app.path().app_data_dir()?;
    create_dir_all(&directory)?;
    Ok(directory)
}

fn stop_harness(app: &AppHandle) {
    let state = app.state::<HarnessProcess>();
    let mut process = state.0.lock().expect("harness child lock poisoned");
    if let Some(child) = process.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }
    *process = None;
}

fn main() {
    let app = tauri::Builder::default()
        .manage(HarnessProcess(Mutex::new(None)))
        .setup(|app| {
            let runtime = app.path().resource_dir()?.join("runtime");
            let node = runtime.join(if cfg!(target_os = "windows") { "node.exe" } else { "node" });
            let entry = runtime.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
            let data = app_data_dir(app)?;
            let log = File::create(data.join("server.log"))?;
            let port = reserve_loopback_port()?;
            let working_directory = env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| data.clone());

            let mut child = Command::new(node)
                .arg(entry)
                .args(["web", "--host", "127.0.0.1", "--port", &port.to_string()])
                .current_dir(working_directory)
                .env("DSH_HOME", data.join("dsh"))
                .stdout(Stdio::from(log.try_clone()?))
                .stderr(Stdio::from(log))
                .spawn()?;

            if let Err(error) = wait_for_server(port) {
                let _ = child.kill();
                return Err(error.into());
            }

            *app.state::<HarnessProcess>()
                .0
                .lock()
                .expect("harness child lock poisoned") = Some(child);
            let url = format!("http://127.0.0.1:{port}").parse()?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("DeepSeek Harness")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 640.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Tauri application");

    app.run(|app, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            stop_harness(app);
        }
    });
}
