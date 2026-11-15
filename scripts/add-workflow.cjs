/* 补推定时任务文件。
   前提：本机 GitHub 凭据对应的 token 已具备 Workflows: Read and write 权限
        （fine-grained token 在 GitHub → Settings → Developer settings 里加）。
   用法：node scripts/add-workflow.cjs
   作用：基于当前 main 分支，仅追加 .github/workflows/refresh-assets.yml，一次提交。
   不会打印任何凭据。*/
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const API = 'https://api.github.com/repos/xkx121029/xkx121029';
const WF_PATH = '.github/workflows/refresh-assets.yml';
const WF_FILE = path.join(__dirname, '..', WF_PATH);
const BODY = path.join(__dirname, '.add-wf-body.json');

const cred = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
});
const token = (cred.match(/^password=(.+)$/m) || [])[1];
if (!token) throw new Error('本机未找到 github.com 凭据');

function api(method, urlPath, body) {
  const args = [
    '-sS', '--location', '--connect-timeout', '8', '--max-time', '40',
    '-X', method,
    '-H', `Authorization: Bearer ${token.trim()}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
    '-H', 'Content-Type: application/json',
    '-H', 'User-Agent: profile-push/1.0',
    '-w', '\n__STATUS__%{http_code}',
  ];
  if (body !== undefined) {
    fs.writeFileSync(BODY, JSON.stringify(body));
    args.push('--data-binary', '@' + path.basename(BODY));
  }
  args.push(API + urlPath);
  let out;
  for (let i = 0; i < 4; i++) {
    try {
      out = execFileSync('curl', args, { encoding: 'utf8', cwd: __dirname, maxBuffer: 8 * 1024 * 1024 });
      break;
    } catch (e) {
      if (i === 3) throw new Error('网络请求失败: ' + String(e.message).slice(0, 160));
    }
  }
  const idx = out.lastIndexOf('\n__STATUS__');
  const text = out.slice(0, idx);
  const status = Number(out.slice(idx + '\n__STATUS__'.length).trim());
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}: ${text.slice(0, 240)}`);
  return text ? JSON.parse(text) : {};
}

try {
  const ref = api('GET', '/git/ref/heads/main');
  const head = api('GET', `/git/commits/${ref.object.sha}`);
  const blob = api('POST', '/git/blobs', {
    content: fs.readFileSync(WF_FILE).toString('base64'), encoding: 'base64',
  });
  const tree = api('POST', '/git/trees', {
    base_tree: head.tree.sha,
    tree: [{ path: WF_PATH, mode: '100644', type: 'blob', sha: blob.sha }],
  });
  const commit = api('POST', '/git/commits', {
    message: 'ci: enable scheduled profile assets refresh',
    tree: tree.sha,
    parents: [ref.object.sha],
  });
  api('PATCH', '/git/refs/heads/main', { sha: commit.sha, force: false });
  console.log('OK 定时任务已启用，commit', commit.sha.slice(0, 8));
  console.log('接着去 Actions 页手动 Run 一次，并检查 Settings → Actions → Workflow permissions 为 Read and write。');
} catch (e) {
  console.error('失败：', String(e.message).slice(0, 300));
  console.error('若提示 404 / workflow scope，说明 token 仍缺 Workflows: Read and write 权限。');
  process.exitCode = 1;
} finally {
  fs.rmSync(BODY, { force: true });
}
