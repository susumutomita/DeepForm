/**
 * GitHub API ヘルパー
 * リポジトリ作成 + Git Data API でファイルをコミットする。
 */

const GITHUB_API = "https://api.github.com";

interface GitHubFile {
  path: string;
  content: string;
}

interface SaveToGitHubParams {
  token: string;
  sessionId: string;
  theme: string;
  files: GitHubFile[];
  /** 既存リポジトリ URL がある場合は更新コミットを行う */
  existingRepoUrl?: string | null;
  /** カスタムリポジトリ名（指定なしの場合は deepform-{sessionId} を使用） */
  repoName?: string;
}

interface SaveToGitHubResult {
  repoUrl: string;
  commitSha: string;
  filesCommitted: string[];
  isNewRepo: boolean;
}

async function ghFetch(path: string, token: string, options: RequestInit = {}): Promise<Response> {
  const url = path.startsWith("https://") ? path : `${GITHUB_API}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers as Record<string, string> | undefined),
    },
  });
  return res;
}

async function ghJson<T>(path: string, token: string, options: RequestInit = {}, step?: string): Promise<T> {
  const res = await ghFetch(path, token, options);
  if (!res.ok) {
    const body = await res.text();
    const prefix = step ? `[${step}] ` : "";
    throw new Error(`${prefix}GitHub API error ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

/** 認証ユーザー情報を取得する（スコープも確認） */
async function getAuthenticatedUser(token: string): Promise<{ login: string }> {
  const res = await ghFetch("/user", token);
  const scopes = res.headers.get("x-oauth-scopes");
  console.info(`[github-save] token scopes: ${scopes}, token prefix: ${token.slice(0, 8)}...`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[getAuthenticatedUser] GitHub API error ${res.status}: ${body}`);
  }
  return (await res.json()) as { login: string };
}

/** リポジトリを作成する。既に存在する場合は既存リポジトリ情報で解決する */
async function createRepo(
  token: string,
  owner: string,
  name: string,
  description: string,
): Promise<{ full_name: string; html_url: string; default_branch: string; isNew: boolean }> {
  const res = await ghFetch("/user/repos", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      description,
      private: true,
      auto_init: true,
    }),
  });

  if (res.status === 422) {
    // 422 = 名前衝突の可能性 → 既存リポジトリを取得
    const existing = await getRepo(token, owner, name).catch(() => null);
    if (existing) {
      return { ...existing, isNew: false };
    }
    // 既存リポジトリも見つからない場合は 422 の詳細を報告
    const body = await res.text();
    throw new Error(`Failed to create repo (422): ${body}`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create repo: ${res.status} ${body}`);
  }
  const created = (await res.json()) as { full_name: string; html_url: string; default_branch: string };
  return { ...created, isNew: true };
}

/** リポジトリ情報を取得する */
async function getRepo(
  token: string,
  owner: string,
  repo: string,
): Promise<{ full_name: string; html_url: string; default_branch: string }> {
  return ghJson(`/repos/${owner}/${repo}`, token, {}, `getRepo(${owner}/${repo})`);
}

/** GitHub リポジトリ URL から owner と repo を抽出する */
function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

/** auto_init 完了を待つ（git ref が存在するまでリトライ） */
async function waitForRepoReady(token: string, owner: string, repo: string, branch: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const res = await ghFetch(`/repos/${owner}/${repo}/git/ref/heads/${branch}`, token);
    if (res.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Git Data API でファイルをコミットする。
 * 1 コミットに複数ファイルをまとめる。
 */
async function commitFiles(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  files: GitHubFile[],
  message: string,
): Promise<string> {
  // 1. 現在の HEAD ref を取得
  const ref = await ghJson<{ object: { sha: string } }>(
    `/repos/${owner}/${repo}/git/ref/heads/${branch}`,
    token,
    {},
    `commitFiles:getRef(${owner}/${repo}#${branch})`,
  );
  const baseSha = ref.object.sha;

  // 2. 各ファイルの blob を作成
  const treeItems: Array<{ path: string; mode: string; type: string; sha: string }> = [];
  for (const file of files) {
    const blob = await ghJson<{ sha: string }>(`/repos/${owner}/${repo}/git/blobs`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: file.content,
        encoding: "utf-8",
      }),
    });
    treeItems.push({
      path: file.path,
      mode: "100644",
      type: "blob",
      sha: blob.sha,
    });
  }

  // 3. ツリーを作成
  const tree = await ghJson<{ sha: string }>(`/repos/${owner}/${repo}/git/trees`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_tree: baseSha,
      tree: treeItems,
    }),
  });

  // 4. コミットを作成
  const commit = await ghJson<{ sha: string }>(`/repos/${owner}/${repo}/git/commits`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: [baseSha],
    }),
  });

  // 5. ref を更新
  await ghJson(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, token, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sha: commit.sha }),
  });

  return commit.sha;
}

/**
 * GitHub にファイルを保存する。
 * - 初回: リポジトリを作成してコミット
 * - 2 回目以降: 既存リポジトリに更新コミット
 */
export async function saveToGitHub(params: SaveToGitHubParams): Promise<SaveToGitHubResult> {
  const { token, sessionId, theme, files, existingRepoUrl } = params;
  const repoName = params.repoName || `deepform-${sessionId.slice(0, 8)}`;
  const description = `DeepForm: ${theme}`;

  const user = await getAuthenticatedUser(token);
  const owner = user.login;
  console.info(`[github-save] user=${owner}, existingRepoUrl=${existingRepoUrl ?? "none"}, repoName=${repoName}`);

  let repoUrl: string;
  let defaultBranch: string;
  let isNewRepo: boolean;
  let actualOwner = owner;
  let actualRepo = repoName;

  if (existingRepoUrl) {
    // 既存リポジトリに更新 — URL から owner/repo を解析
    const parsed = parseRepoUrl(existingRepoUrl);
    if (parsed) {
      actualOwner = parsed.owner;
      actualRepo = parsed.repo;
    }
    console.info(`[github-save] updating existing repo: ${actualOwner}/${actualRepo}`);
    const repoInfo = await getRepo(token, actualOwner, actualRepo).catch(() => null);
    if (repoInfo) {
      repoUrl = repoInfo.html_url;
      defaultBranch = repoInfo.default_branch;
      isNewRepo = false;
    } else {
      // リポジトリが削除済み等 → 新規作成にフォールバック
      console.info(`[github-save] existing repo not found, creating new: ${owner}/${repoName}`);
      const result = await createRepo(token, owner, repoName, description);
      repoUrl = result.html_url;
      defaultBranch = result.default_branch;
      isNewRepo = result.isNew;
      actualOwner = owner;
      actualRepo = repoName;
      if (isNewRepo) {
        await waitForRepoReady(token, actualOwner, actualRepo, defaultBranch);
        console.info("[github-save] waitForRepoReady done");
      }
    }
  } else {
    // 新規リポジトリ作成（422 時は既存リポジトリにフォールバック）
    console.info(`[github-save] creating new repo: ${owner}/${repoName}`);
    const result = await createRepo(token, owner, repoName, description);
    repoUrl = result.html_url;
    defaultBranch = result.default_branch;
    isNewRepo = result.isNew;
    actualOwner = owner;
    actualRepo = repoName;
    console.info(`[github-save] repo ready: isNew=${isNewRepo}, branch=${defaultBranch}`);

    if (isNewRepo) {
      // auto_init 完了を待つ（最大 5 秒）
      await waitForRepoReady(token, actualOwner, actualRepo, defaultBranch);
      console.info("[github-save] waitForRepoReady done");
    }
  }

  const commitMessage = isNewRepo ? "feat: DeepForm PRD & spec を追加" : "feat: DeepForm PRD & spec を更新";

  const commitSha = await commitFiles(token, actualOwner, actualRepo, defaultBranch, files, commitMessage);

  return {
    repoUrl,
    commitSha,
    filesCommitted: files.map((f) => f.path),
    isNewRepo,
  };
}
