use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

pub struct Paths {
    pub executable: PathBuf,
    pub config: PathBuf,
    pub assets: PathBuf,
}

impl Paths {
    fn command(&self, operation: &str) -> Command {
        let mut c = Command::new(&self.executable);
        c.arg(operation)
            .arg("--config")
            .arg(&self.config)
            .arg("--assets")
            .arg(&self.assets);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000);
        }
        c
    }
    pub fn connection(&self) -> Result<Value, String> {
        let output = self
            .command("connection")
            .output()
            .map_err(|_| "RUNTIME_UNAVAILABLE")?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        serde_json::from_slice(&output.stdout).map_err(|_| "HOST_REPLY_INVALID".into())
    }
}

pub struct Backend {
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    sequence: u64,
    pub connection: Value,
}

impl Backend {
    pub fn start(paths: &Paths, connection: Value) -> Result<Self, String> {
        let mut child = paths
            .command("manager")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|_| "RUNTIME_UNAVAILABLE")?;
        let input = child.stdin.take().ok_or("HOST_PIPE_UNAVAILABLE")?;
        let output = BufReader::new(child.stdout.take().ok_or("HOST_PIPE_UNAVAILABLE")?);
        let mut backend = Self {
            child,
            input: Some(input),
            output,
            sequence: 0,
            connection,
        };
        let ready = match backend.read() {
            Ok(value) => value,
            Err(error) => {
                backend.shutdown()?;
                return Err(error);
            }
        };
        if ready["event"] != "manager-ready"
            || ready["pid"].as_u64() != Some(backend.child.id().into())
            || ready["instanceId"] != backend.connection["instanceId"]
            || ready["manager"]["pid"].as_u64() != Some(std::process::id().into())
        {
            backend.shutdown()?;
            return Err("HOST_IDENTITY_MISMATCH".into());
        }
        Ok(backend)
    }
    fn read(&mut self) -> Result<Value, String> {
        let mut line = String::new();
        let bytes = self
            .output
            .read_line(&mut line)
            .map_err(|_| "HOST_PIPE_FAILED")?;
        if bytes == 0 {
            return Err("HOST_SESSION_ENDED".into());
        }
        serde_json::from_str(&line).map_err(|_| "HOST_REPLY_INVALID".into())
    }
    pub fn call(&mut self, command: &str, operation: &str, input: Value) -> Result<Value, String> {
        self.sequence += 1;
        let id = self.sequence;
        let line = serde_json::to_vec(
            &json!({"id": id, "command": command, "operation": operation, "input": input}),
        )
        .map_err(|_| "HOST_INPUT_INVALID")?;
        let pipe = self.input.as_mut().ok_or("HOST_SESSION_ENDED")?;
        pipe.write_all(&line)
            .and_then(|_| pipe.write_all(b"\n"))
            .and_then(|_| pipe.flush())
            .map_err(|_| "HOST_PIPE_FAILED")?;
        let reply = match self.read() {
            Ok(v) => v,
            Err(e) => {
                self.input.take();
                return Err(e);
            }
        };
        if reply["id"].as_u64() != Some(id) {
            self.input.take();
            return Err("HOST_REPLY_INVALID".into());
        }
        if reply["ok"] != true {
            return Err(reply["code"]
                .as_str()
                .unwrap_or("HOST_REQUEST_FAILED")
                .into());
        }
        Ok(reply["data"].clone())
    }
    pub fn shutdown(&mut self) -> Result<(), String> {
        self.input.take();
        let status = self.child.wait().map_err(|_| "HOST_WAIT_FAILED")?;
        if status.success() {
            Ok(())
        } else {
            Err("HOST_EXIT_FAILED".into())
        }
    }
}

pub fn resource(root: &Path, relative: &str) -> Result<Vec<u8>, String> {
    let path = Path::new(relative);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
        || !(relative.starts_with("misans/")
            || relative.starts_with("misans-cdn/")
            || relative == "fonts/noto-color-emoji.ttf")
    {
        return Err("RESOURCE_FORBIDDEN".into());
    }
    let root = root.canonicalize().map_err(|_| "RESOURCE_UNAVAILABLE")?;
    let mut target = root.clone();
    for part in path.components() {
        target.push(part);
        let metadata = std::fs::symlink_metadata(&target).map_err(|_| "RESOURCE_UNAVAILABLE")?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("RESOURCE_FORBIDDEN".into());
            }
        }
        if metadata.is_symlink() {
            return Err("RESOURCE_FORBIDDEN".into());
        }
    }
    if !target
        .canonicalize()
        .map_err(|_| "RESOURCE_UNAVAILABLE")?
        .starts_with(root)
    {
        return Err("RESOURCE_FORBIDDEN".into());
    }
    std::fs::read(target).map_err(|_| "RESOURCE_UNAVAILABLE".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resource_rejects_escape_before_reading() {
        for path in [
            "../config.json",
            "misans/../../config.json",
            "C:/private",
            "other/file",
            "/misans/file",
        ] {
            assert_eq!(
                resource(Path::new("missing"), path).unwrap_err(),
                "RESOURCE_FORBIDDEN"
            );
        }
    }
}
