import fs from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
const meta = JSON.parse(fs.readFileSync(root + 'scripts/cluster-meta.json', 'utf8'));
for (const file of ['public/data/graph.json', 'public/data/build-report.json']) {
  const data = JSON.parse(fs.readFileSync(root + file, 'utf8'));
  const target = file.endsWith('graph.json') ? data.meta : data.meta;
  target.clusters = target.clusters.map((c, i) => ({ ...c, ...meta.clusters[i] }));
  fs.writeFileSync(root + file, JSON.stringify(data));
}
console.log('Relabelled', meta.clusters.length, 'clusters');
