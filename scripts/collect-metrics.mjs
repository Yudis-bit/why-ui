import fs from 'node:fs';
const repo = process.env.GITHUB_REPOSITORY ?? 'Yudis-bit/why-ui';
const get = async route => {
  const response = await fetch(`https://api.github.com/repos/${repo}${route}`, { headers: {
    Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
    ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
  }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`GitHub metrics request failed: ${response.status}`);
  return response.json();
};
const [repository, pulls, releases, runs] = await Promise.all([get(''), get('/pulls?state=open&per_page=100'), get('/releases?per_page=100'), get('/actions/runs?per_page=10')]);
const assets = releases.flatMap(release => release.assets.map(asset => ({ release: release.tag_name, name: asset.name, downloads: asset.download_count })));
const metrics = { capturedAt: new Date().toISOString(), repository: repository.html_url,
  stars: repository.stargazers_count, forks: repository.forks_count, watchers: repository.subscribers_count,
  openPullRequests: pulls.length < 100 ? pulls.length : null,
  openIssues: pulls.length < 100 ? repository.open_issues_count - pulls.length : null,
  releaseDownloads: assets.reduce((n, asset) => n + asset.downloads, 0), assets,
  limits: 'PR/release lists capped at 100. Download counts include maintainer validation; they are not unique users.',
  actions: runs.workflow_runs.map(run => ({ name: run.name, status: run.status, conclusion: run.conclusion, sha: run.head_sha, url: run.html_url })) };
fs.mkdirSync('metrics', { recursive: true }); fs.writeFileSync('metrics/launch.json', JSON.stringify(metrics, null, 2));
console.log('Public aggregate metrics written to metrics/launch.json; no user profiles collected.');
