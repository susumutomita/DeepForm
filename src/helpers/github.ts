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

async function ghJson<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const res = await ghFetch(path, token, options);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

/** 認証ユーザー情報を取得する */
async function getAuthenticatedUser(token: string): Promise<{ login: string }> {
  return ghJson("/user", token);
}

/** リポジトリを作成する。既に存在する場合は null を返す */
async function createRepo(
  token: string,
  name: string,
  description: string,
): Promise<{ full_name: string; html_url: string; default_branch: string } | null> {
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
    // リポジトリ名が既に存在する
    return null;
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create repo: ${res.status} ${body}`);
  }
  return (await res.json()) as { full_name: string; html_url: string; default_branch: string };
}

/** リポジトリ情報を取得する */
async function getRepo(
  token: string,
  owner: string,
  repo: string,
): Promise<{ full_name: string; html_url: string; default_branch: string }> {
  return ghJson(`/repos/${owner}/${repo}`, token);
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
  const ref = await ghJson<{ object: { sha: string } }>(`/repos/${owner}/${repo}/git/ref/heads/${branch}`, token);
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

  let repoUrl: string;
  let defaultBranch: string;
  let isNewRepo: boolean;

  if (existingRepoUrl) {
    // 既存リポジトリに更新
    const repoInfo = await getRepo(token, owner, repoName);
    repoUrl = repoInfo.html_url;
    defaultBranch = repoInfo.default_branch;
    isNewRepo = false;
  } else {
    // 新規リポジトリ作成
    const created = await createRepo(token, repoName, description);
    if (created) {
      repoUrl = created.html_url;
      defaultBranch = created.default_branch;
      isNewRepo = true;
      // auto_init で作成されるまで少し待つ
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } else {
      // 既に存在する場合はそのリポジトリを使用
      const repoInfo = await getRepo(token, owner, repoName);
      repoUrl = repoInfo.html_url;
      defaultBranch = repoInfo.default_branch;
      isNewRepo = false;
    }
  }

  const commitMessage = isNewRepo ? "feat: DeepForm PRD & spec を追加" : "feat: DeepForm PRD & spec を更新";

  const commitSha = await commitFiles(token, owner, repoName, defaultBranch, files, commitMessage);

  return {
    repoUrl,
    commitSha,
    filesCommitted: files.map((f) => f.path),
    isNewRepo,
  };
}
