//! PathLockProvider trait and built-in implementations.
//!
//! The provider owns token storage. Backends with transactional storage may also
//! implement the optional atomic capabilities used by `PathLockManager`.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::RwLock;

use crate::core::internal_names::is_hidden_runtime_lock_name;
use crate::core::FileSystem;
use crate::crypto;

use super::codec::LockTokenCodec;
use super::types::{LockToken, PathLockError, PathLockRequest, PathLockResult};

/// Representation used for handles stored in a PathLock lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathLockHandleMode {
    /// Handles are resolver-generated lock-file paths.
    LockPath,
    /// Handles are normalized logical paths.
    LogicalPath,
}

/// Token mutation made during one lock acquisition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcquisitionChange {
    /// A new token was created.
    Created {
        /// Token written by the provider.
        replacement: LockToken,
    },
    /// The same owner already held an equal or stronger token.
    Reentrant,
    /// A same-owner Exact token became Tree.
    Upgraded {
        /// Token restored if local lease publication fails.
        previous: LockToken,
        /// Tree token written by the provider.
        replacement: LockToken,
    },
}

/// One mutation made by an atomic provider acquisition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AtomicAcquisition {
    /// Provider handle stored in the PathLock lease.
    pub handle: String,
    /// Token mutation used by rollback.
    pub change: AcquisitionChange,
}

/// Storage abstraction for lock tokens. Only `PathLockManager` should call these methods.
#[async_trait]
pub trait PathLockProvider: Send + Sync {
    /// Human-readable provider name for config/logging/metrics.
    fn name(&self) -> &'static str;

    /// Return how this provider represents lease handles.
    fn handle_mode(&self) -> PathLockHandleMode {
        PathLockHandleMode::LockPath
    }

    /// Attempt one atomic batch acquisition when supported.
    async fn try_acquire_batch_atomic(
        &self,
        _requests: &[PathLockRequest],
        _owner_id: &str,
        _now_ns: u128,
        _stale_before_ns: u128,
    ) -> PathLockResult<Option<Vec<AtomicAcquisition>>> {
        Ok(None)
    }

    /// Roll back one completed atomic acquisition when supported.
    async fn rollback_acquisitions_atomic(
        &self,
        _acquisitions: &[AtomicAcquisition],
        _owner_id: &str,
    ) -> PathLockResult<Option<()>> {
        Ok(None)
    }

    /// Return whether one path is covered by a live token when supported.
    async fn is_path_locked_atomic(
        &self,
        _path: &str,
        _now_ns: u128,
        _stale_before_ns: u128,
        _ignore_stale: bool,
    ) -> PathLockResult<Option<bool>> {
        Ok(None)
    }

    /// Read the token at `lock_path`, returning `None` if no token exists.
    async fn read_token(&self, lock_path: &str) -> PathLockResult<Option<LockToken>>;

    /// Atomically create a token at `lock_path`. Must fail if a token already exists
    /// (unless it is stale and can be cleaned up by the manager).
    async fn try_create_token(&self, lock_path: &str, token: &LockToken) -> PathLockResult<()>;

    /// Atomically replace one exact token value.
    async fn compare_and_write_token(
        &self,
        lock_path: &str,
        expected: &LockToken,
        replacement: &LockToken,
    ) -> PathLockResult<bool>;

    /// Refresh the timestamp of an existing token owned by `owner_id`.
    /// Returns `true` if the token was refreshed, `false` if not found or wrong owner.
    async fn refresh_token(
        &self,
        lock_path: &str,
        owner_id: &str,
        time_ns: u128,
    ) -> PathLockResult<bool>;

    /// Remove the token at `lock_path` if owned by `owner_id`.
    /// `force` bypasses storage CAS after the ownership check.
    /// Returns `true` if removed, `false` if not found or wrong owner.
    async fn remove_token(
        &self,
        lock_path: &str,
        owner_id: &str,
        force: bool,
    ) -> PathLockResult<bool>;

    /// Scan all descendant lock paths under `root`.
    async fn scan_descendant_locks(&self, root: &str) -> PathLockResult<Vec<String>>;
}

// ── Memory provider ──

/// In-process lock table backed by a `HashMap`. Single-process only.
pub struct MemoryPathLockProvider {
    tokens: RwLock<HashMap<String, LockToken>>,
}

impl MemoryPathLockProvider {
    /// Create an empty in-memory provider.
    pub fn new() -> Self {
        Self {
            tokens: RwLock::new(HashMap::new()),
        }
    }
}

impl Default for MemoryPathLockProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl PathLockProvider for MemoryPathLockProvider {
    fn name(&self) -> &'static str {
        "memory"
    }

    async fn read_token(&self, lock_path: &str) -> PathLockResult<Option<LockToken>> {
        Ok(self.tokens.read().await.get(lock_path).cloned())
    }

    async fn try_create_token(&self, lock_path: &str, token: &LockToken) -> PathLockResult<()> {
        let mut tokens = self.tokens.write().await;
        if tokens.contains_key(lock_path) {
            return Err(PathLockError::Conflict {
                lock_path: lock_path.to_string(),
                owner: tokens[lock_path].owner_id.clone(),
                kind: tokens[lock_path].lock_type,
            });
        }
        tokens.insert(lock_path.to_string(), token.clone());
        Ok(())
    }

    async fn compare_and_write_token(
        &self,
        lock_path: &str,
        expected: &LockToken,
        replacement: &LockToken,
    ) -> PathLockResult<bool> {
        let mut tokens = self.tokens.write().await;
        match tokens.get(lock_path) {
            Some(token) if token == expected => {
                tokens.insert(lock_path.to_string(), replacement.clone());
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    async fn refresh_token(
        &self,
        lock_path: &str,
        owner_id: &str,
        time_ns: u128,
    ) -> PathLockResult<bool> {
        let mut tokens = self.tokens.write().await;
        match tokens.get_mut(lock_path) {
            Some(token) if token.owner_id == owner_id => {
                token.time_ns = time_ns;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    async fn remove_token(
        &self,
        lock_path: &str,
        owner_id: &str,
        _force: bool,
    ) -> PathLockResult<bool> {
        let mut tokens = self.tokens.write().await;
        match tokens.get(lock_path) {
            Some(token) if token.owner_id == owner_id => {
                tokens.remove(lock_path);
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    async fn scan_descendant_locks(&self, root: &str) -> PathLockResult<Vec<String>> {
        let prefix = if root.ends_with('/') {
            root.to_string()
        } else {
            format!("{}/", root)
        };
        Ok(self
            .tokens
            .read()
            .await
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect())
    }
}

// ── Filesystem provider ──

/// Lock provider that stores tokens as files on the underlying filesystem.
pub struct FilesystemPathLockProvider {
    fs: Arc<dyn FileSystem>,
    empty_token_expire_secs: f64,
}

impl FilesystemPathLockProvider {
    /// Create a filesystem-backed provider with an explicit empty-token expiry.
    ///
    /// `fs` stores lock files, and `lock_expire_secs` controls empty-token recovery.
    /// Returns a configured filesystem provider.
    pub fn new(fs: Arc<dyn FileSystem>, lock_expire_secs: f64) -> Self {
        Self {
            fs,
            empty_token_expire_secs: lock_expire_secs,
        }
    }

    /// Read raw token bytes from `lock_path`, returning `None` if no token exists.
    async fn read_token_raw(&self, lock_path: &str) -> PathLockResult<Option<Vec<u8>>> {
        let mut result = self.fs.read(lock_path, 0, 0).await;
        if result
            .as_ref()
            .is_ok_and(|data| LockTokenCodec::decode(String::from_utf8_lossy(data).trim()).is_err())
        {
            // A concurrent in-place CAS write can expose a transient partial token.
            tokio::task::yield_now().await;
            result = self.fs.read(lock_path, 0, 0).await;
        }
        match result {
            Ok(data) => Ok(Some(data)),
            Err(crate::core::Error::WouldBlock(message)) => Err(PathLockError::Busy {
                lock_path: lock_path.to_string(),
                operation: format!("read lock token ({message})"),
            }),
            Err(e) => {
                if matches!(
                    e,
                    crate::core::Error::NotFound(_) | crate::core::Error::MountPointNotFound(_)
                ) {
                    Ok(None)
                } else {
                    Err(PathLockError::Io(format!(
                        "failed to read lock token at '{lock_path}': {e}"
                    )))
                }
            }
        }
    }

    /// Map filesystem CAS failures into pathlock busy vs. fatal I/O outcomes.
    fn map_cas_error(operation: &str, lock_path: &str, error: crate::core::Error) -> PathLockError {
        match error {
            crate::core::Error::WouldBlock(message) => PathLockError::Busy {
                lock_path: lock_path.to_string(),
                operation: format!("{operation} CAS ({message})"),
            },
            other => PathLockError::Io(format!("{operation} CAS failed: {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::core::{Error, FileSystem, WriteFlag};
    use crate::plugins::localfs::LocalFileSystem;
    use crate::plugins::memfs::MemFileSystem;

    use super::*;

    /// Verify legacy encrypted lock files are treated as removable upgrade leftovers.
    #[tokio::test]
    async fn read_token_cleans_up_legacy_encrypted_lock() {
        let fs = Arc::new(MemFileSystem::new());
        fs.mkdir("/data", 0o755).await.unwrap();
        fs.write(
            "/data/.path.ovlock",
            b"OVE1legacy-ciphertext",
            0,
            WriteFlag::Create,
        )
        .await
        .unwrap();
        let provider = FilesystemPathLockProvider::new(fs.clone(), 30.0);

        let token = provider.read_token("/data/.path.ovlock").await.unwrap();

        assert!(token.is_none());
        assert!(matches!(
            fs.read("/data/.path.ovlock", 0, 0).await,
            Err(Error::NotFound(_))
        ));
    }

    /// Verify malformed non-legacy lock files still surface as invalid tokens.
    #[tokio::test]
    async fn read_token_rejects_non_legacy_invalid_lock() {
        let fs = Arc::new(MemFileSystem::new());
        fs.mkdir("/data", 0o755).await.unwrap();
        fs.write("/data/.path.ovlock", b"not-a-token", 0, WriteFlag::Create)
            .await
            .unwrap();
        let provider = FilesystemPathLockProvider::new(fs.clone(), 30.0);

        let err = provider.read_token("/data/.path.ovlock").await.unwrap_err();

        assert!(matches!(err, PathLockError::InvalidToken(_)));
        assert_eq!(
            fs.read("/data/.path.ovlock", 0, 0).await.unwrap(),
            b"not-a-token"
        );
    }

    /// Verify valid plaintext lock files continue to decode unchanged.
    #[tokio::test]
    async fn read_token_accepts_plaintext_lock() {
        let fs = Arc::new(MemFileSystem::new());
        fs.mkdir("/data", 0o755).await.unwrap();
        fs.write("/data/.path.ovlock", b"owner:123:E", 0, WriteFlag::Create)
            .await
            .unwrap();
        let provider = FilesystemPathLockProvider::new(fs, 30.0);

        let token = provider
            .read_token("/data/.path.ovlock")
            .await
            .unwrap()
            .unwrap();

        assert_eq!(token.owner_id, "owner");
        assert_eq!(token.time_ns, 123);
        assert_eq!(token.lock_type, crate::lock::PathLockKind::Exact);
    }

    #[test]
    fn compare_and_remove_would_block_maps_to_busy() {
        let err = FilesystemPathLockProvider::map_cas_error(
            "remove",
            "/data/.path.ovlock",
            Error::WouldBlock("lock would block".to_string()),
        );
        assert!(matches!(err, PathLockError::Busy { .. }));
    }

    fn lock_test_file(path: &std::path::Path) -> filelocks::FileLock {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        filelocks::LockOptions::new()
            .backend(filelocks::LockBackend::Fcntl)
            .lock(
                file,
                filelocks::LockKind::Exclusive,
                filelocks::LockMode::NonBlocking,
            )
            .unwrap()
    }

    #[tokio::test]
    async fn local_lock_read_waits_for_complete_token() {
        use std::io::{Seek, SeekFrom, Write};

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".path.ovlock");
        std::fs::write(&path, b"owner:123:E").unwrap();
        let mut guard = lock_test_file(&path);
        // Model refresh between truncation and writing the replacement token.
        guard.file_mut().set_len(0).unwrap();
        let fs = Arc::new(LocalFileSystem::new(dir.path().to_str().unwrap()).unwrap());
        let provider = FilesystemPathLockProvider::new(fs, 30.0);
        let reader = tokio::spawn(async move { provider.read_token("/.path.ovlock").await });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!reader.is_finished(), "read must wait for the writer's lock");
        guard.file_mut().seek(SeekFrom::Start(0)).unwrap();
        guard.file_mut().write_all(b"owner:456:E").unwrap();
        drop(guard);

        let token = reader.await.unwrap().unwrap().unwrap();
        assert_eq!(token.time_ns, 456);
        assert_eq!(token.owner_id, "owner");
    }

    #[tokio::test]
    async fn local_lock_read_timeout_is_busy_and_can_be_retried() {
        use std::time::{Duration, Instant};

        let dir = tempfile::tempdir().unwrap();
        // Exact lock sidecars need the same protection as directory locks.
        let name = "/.exact.ovlock.notes.md.0123456789abcdef";
        let path = dir.path().join(&name[1..]);
        std::fs::write(&path, b"owner:123:E").unwrap();
        let guard = lock_test_file(&path);
        let fs = Arc::new(LocalFileSystem::new(dir.path().to_str().unwrap()).unwrap());
        let provider = FilesystemPathLockProvider::new(fs, 30.0);
        let started = Instant::now();
        let result = tokio::time::timeout(Duration::from_secs(5), provider.read_token(name))
            .await
            .unwrap();
        assert!(matches!(result, Err(PathLockError::Busy { lock_path, .. }) if lock_path == name));
        assert!(started.elapsed() >= Duration::from_millis(250));
        drop(guard);
        assert_eq!(
            provider.read_token(name).await.unwrap().unwrap().time_ns,
            123
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn local_lock_reads_race_with_refresh_without_invalid_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let fs = Arc::new(LocalFileSystem::new(dir.path().to_str().unwrap()).unwrap());
        let provider = Arc::new(FilesystemPathLockProvider::new(fs, 30.0));
        let token = LockToken {
            owner_id: "owner".to_string(),
            time_ns: 1,
            lock_type: crate::lock::PathLockKind::Tree,
        };
        provider
            .try_create_token("/.path.ovlock", &token)
            .await
            .unwrap();
        let writer_provider = provider.clone();
        let writer = tokio::spawn(async move {
            for time_ns in 2..=200 {
                loop {
                    match writer_provider
                        .refresh_token("/.path.ovlock", "owner", time_ns)
                        .await
                    {
                        Ok(true) => break,
                        Err(PathLockError::Busy { .. }) => tokio::task::yield_now().await,
                        other => panic!("unexpected refresh result: {other:?}"),
                    }
                }
            }
        });
        let mut readers = Vec::new();
        for _ in 0..3 {
            let provider = provider.clone();
            readers.push(tokio::spawn(async move {
                for _ in 0..200 {
                    match provider.read_token("/.path.ovlock").await {
                        Ok(Some(token)) => {
                            assert_eq!(token.owner_id, "owner");
                            assert!((1..=200).contains(&token.time_ns));
                        }
                        Err(PathLockError::Busy { .. }) => (),
                        other => panic!("unexpected read result: {other:?}"),
                    }
                }
            }));
        }
        tokio::time::timeout(std::time::Duration::from_secs(10), writer)
            .await
            .expect("refresh should not starve behind readers")
            .unwrap();
        for reader in readers {
            reader.await.unwrap();
        }
        assert_eq!(
            provider.read_token("/.path.ovlock").await.unwrap().unwrap().time_ns,
            200
        );
    }
}

#[async_trait]
impl PathLockProvider for FilesystemPathLockProvider {
    fn name(&self) -> &'static str {
        "filesystem"
    }

    async fn read_token(&self, lock_path: &str) -> PathLockResult<Option<LockToken>> {
        let mut current = self.read_token_raw(lock_path).await?;
        loop {
            match current {
                Some(data) => {
                    if data.is_empty() {
                        let info = match self.fs.stat(lock_path).await {
                            Ok(info) => info,
                            Err(
                                crate::core::Error::NotFound(_)
                                | crate::core::Error::MountPointNotFound(_),
                            ) => return Ok(None),
                            Err(error) => {
                                return Err(PathLockError::Io(format!(
                                    "failed to stat empty lock token at '{lock_path}': {error}"
                                )));
                            }
                        };
                        let age = std::time::SystemTime::now()
                            .duration_since(info.mod_time)
                            .unwrap_or_default()
                            .as_secs_f64();
                        if age <= self.empty_token_expire_secs {
                            return Err(PathLockError::EmptyToken {
                                lock_path: lock_path.to_string(),
                            });
                        }
                        return Ok(None);
                    }
                    let raw = String::from_utf8_lossy(&data).trim().to_string();
                    match LockTokenCodec::decode(&raw) {
                        Ok(token) => return Ok(Some(token)),
                        Err(error) if crypto::is_encrypted(&data) => {
                            if self
                                .fs
                                .compare_and_remove(lock_path, &data)
                                .await
                                .map_err(|e| {
                                    Self::map_cas_error(
                                        "legacy encrypted lock cleanup",
                                        lock_path,
                                        e,
                                    )
                                })?
                            {
                                return Ok(None);
                            }
                            current = self.read_token_raw(lock_path).await?;
                        }
                        Err(error) => return Err(error),
                    }
                }
                None => return Ok(None),
            }
        }
    }

    async fn try_create_token(&self, lock_path: &str, token: &LockToken) -> PathLockResult<()> {
        use crate::core::WriteFlag;

        let encoded = LockTokenCodec::encode(token);
        let mut last_error = None;
        for _ in 0..2 {
            let error = match self
                .fs
                .write(lock_path, encoded.as_bytes(), 0, WriteFlag::CreateNew)
                .await
            {
                Ok(_) => return Ok(()),
                Err(error) => error,
            };
            match self.read_token(lock_path).await? {
                // Already exists — read and check if stale.
                Some(t) => {
                    return Err(PathLockError::Conflict {
                        lock_path: lock_path.to_string(),
                        owner: t.owner_id,
                        kind: t.lock_type,
                    });
                }
                None => {
                    last_error = Some(error);
                    if self
                        .fs
                        .compare_and_write(lock_path, b"", encoded.as_bytes())
                        .await
                        .map_err(|e| Self::map_cas_error("empty lock recovery", lock_path, e))?
                    {
                        return Ok(());
                    }
                }
            }
        }
        Err(PathLockError::Io(format!(
            "failed to create lock token at {lock_path}: {}",
            last_error.unwrap()
        )))
    }

    async fn compare_and_write_token(
        &self,
        lock_path: &str,
        expected: &LockToken,
        replacement: &LockToken,
    ) -> PathLockResult<bool> {
        let expected = LockTokenCodec::encode(expected);
        let replacement = LockTokenCodec::encode(replacement);
        self.fs
            .compare_and_write(lock_path, expected.as_bytes(), replacement.as_bytes())
            .await
            .map_err(|e| Self::map_cas_error("compare_and_write", lock_path, e))
    }

    async fn refresh_token(
        &self,
        lock_path: &str,
        owner_id: &str,
        time_ns: u128,
    ) -> PathLockResult<bool> {
        let Some(raw) = self.read_token_raw(lock_path).await? else {
            return Ok(false);
        };
        let token = LockTokenCodec::decode(&String::from_utf8_lossy(&raw).trim())?;
        if token.owner_id != owner_id {
            return Ok(false);
        }
        let new_token = LockToken {
            owner_id: owner_id.to_string(),
            time_ns,
            lock_type: token.lock_type,
        };
        let encoded = LockTokenCodec::encode(&new_token);
        self.fs
            .compare_and_write(lock_path, &raw, encoded.as_bytes())
            .await
            .map_err(|e| Self::map_cas_error("refresh", lock_path, e))
    }

    async fn remove_token(
        &self,
        lock_path: &str,
        owner_id: &str,
        force: bool,
    ) -> PathLockResult<bool> {
        let Some(raw) = self.read_token_raw(lock_path).await? else {
            return Ok(false);
        };
        let token = LockTokenCodec::decode(&String::from_utf8_lossy(&raw).trim())?;
        if token.owner_id != owner_id {
            return Ok(false);
        }
        if force {
            return match self.fs.remove(lock_path).await {
                Ok(()) => Ok(true),
                Err(
                    crate::core::Error::NotFound(_) | crate::core::Error::MountPointNotFound(_),
                ) => Ok(false),
                Err(error) => Err(PathLockError::Io(format!(
                    "failed to force remove lock token at '{lock_path}': {error}"
                ))),
            };
        }
        self.fs
            .compare_and_remove(lock_path, &raw)
            .await
            .map_err(|e| Self::map_cas_error("remove", lock_path, e))
    }

    async fn scan_descendant_locks(&self, root: &str) -> PathLockResult<Vec<String>> {
        let mut result = Vec::new();
        self.scan_recursive(root, &mut result).await?;
        Ok(result)
    }
}

impl FilesystemPathLockProvider {
    /// Recursively scan a directory for `.path.ovlock` and `.exact.ovlock.*` files.
    fn is_lock_file(name: &str) -> bool {
        is_hidden_runtime_lock_name(name)
    }

    async fn scan_recursive(&self, dir: &str, result: &mut Vec<String>) -> PathLockResult<()> {
        let entries = match self.fs.read_internal_dir(dir).await {
            Ok(entries) => entries,
            Err(crate::core::Error::NotFound(_) | crate::core::Error::NotADirectory(_)) => {
                return Ok(());
            }
            Err(error) => {
                return Err(PathLockError::Io(format!(
                    "failed to scan lock directory '{dir}': {error}"
                )));
            }
        };

        for entry in entries {
            let child_path = if dir.ends_with('/') {
                format!("{}{}", dir, entry.name)
            } else {
                format!("{}/{}", dir, entry.name)
            };

            if Self::is_lock_file(&entry.name) {
                result.push(child_path);
            } else if entry.is_dir {
                Box::pin(self.scan_recursive(&child_path, result)).await?;
            }
        }
        Ok(())
    }
}
