// scripts/afterSign.js
// Signs bundled MySQL binaries inside the packaged app on macOS
// Uses CSC_NAME if set; otherwise auto-detects a Developer ID Application identity

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function log(...a) { console.log('[afterSign]', ...a); }

function isExec(mode) { return (mode & 0o111) !== 0; }
function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, files);
    else files.push({ p, st });
  }
  return files;
}

function pickIdentity() {
  if (process.env.CSC_NAME) return process.env.CSC_NAME;
  try {
    const out = execSync('security find-identity -p codesigning -v', { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      if (line.includes('Developer ID Application:')) {
        const m = line.match(/"(Developer ID Application: [^"]+)"/);
        if (m) return m[1];
      }
    }
  } catch {}
  return null;
}

module.exports = async function(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const identity = pickIdentity();
  if (!identity) { log('No signing identity found; skipping MySQL sidecar signing'); return; }

  const appDir = context.appOutDir;
  const appBundle = fs.readdirSync(appDir).find(f => f.endsWith('.app'));
  if (!appBundle) { log('No .app found in', appDir); return; }
  const appPath = path.join(appDir, appBundle);
  const resourcesDir = path.join(appPath, 'Contents', 'Resources');
  const sidecarRoot = path.join(resourcesDir, 'resources', 'mysql');
  if (!fs.existsSync(sidecarRoot)) { log('No sidecar mysql folder in app'); return; }

  const files = walk(sidecarRoot);
  const targets = files
    .filter(({ p, st }) => isExec(st.mode) || /\.(dylib|so|bundle)$/i.test(p))
    .map(({ p, st }) => ({ p, isExec: isExec(st.mode) }));

  if (targets.length === 0) { log('No files to sign under', sidecarRoot); return; }
  log('Signing', targets.length, 'files with identity:', identity);

  const entitlements = path.join(__dirname, 'macos', 'sidecar-entitlements.plist');
  const hasEntitlements = fs.existsSync(entitlements);

  for (const { p: file, isExec } of targets) {
    try {
      const cmd = isExec && hasEntitlements
        ? `codesign --force --options runtime --timestamp --entitlements "${entitlements}" --sign "${identity}" "${file}"`
        : `codesign --force --options runtime --timestamp --sign "${identity}" "${file}"`;
      execSync(cmd, { stdio: 'inherit' });
    } catch (e) {
      log('codesign failed for', file, e.message);
      throw e;
    }
  }
  log('MySQL sidecar binaries signed');
};
