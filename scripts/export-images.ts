#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

interface Variant { id: number; sku: string | null }
interface Image { src: string; position: number; variant_ids?: number[] }
interface Product { handle: string; variants: Variant[]; images: Image[] }

interface Job {
  collection: string;
  handle: string;
  sku: string;
  position: number;
  filename: string;
  sourceUrl: string;
  dir: string;
}
type Status = 'downloaded' | 'skipped' | 'failed';
interface Result { job: Job; status: Status }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sanitize(s: string): string {
  return s.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function stripQuery(url: string): string {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.toString();
}

function extOf(url: string): string {
  const m = new URL(url).pathname.match(/\.([A-Za-z0-9]+)$/);
  return m ? m[1].toLowerCase() : 'jpg';
}

function resolveSku(p: Product, img: Image): string {
  const ids = new Set(img.variant_ids ?? []);
  const byImage = p.variants.find((v) => ids.has(v.id) && v.sku && v.sku.trim());
  if (byImage?.sku) return byImage.sku;
  const first = p.variants[0]?.sku;
  if (first && first.trim()) return first;
  return p.handle;
}

/** Hands out unique filenames per directory, appending -2, -3 on collisions. */
class NameAllocator {
  private used = new Map<string, Set<string>>();
  allocate(dir: string, sku: string, position: number, ext: string): string {
    const set = this.used.get(dir) ?? new Set<string>();
    this.used.set(dir, set);
    const base = `${sanitize(sku)}_${position}`;
    let name = `${base}.${ext}`;
    for (let n = 2; set.has(name.toLowerCase()); n++) {
      name = `${base}-${n}.${ext}`;
    }
    if (name !== `${base}.${ext}`) console.warn(`warning: duplicate filename ${base}.${ext} in ${dir}, using ${name}`);
    set.add(name.toLowerCase());
    return name;
  }
}

class HttpError extends Error {
  status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

async function fetchRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let wait = BASE_DELAY_MS * 2 ** (attempt - 1);
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      await res.body?.cancel();
      const err = new HttpError(res.status, url);
      if (res.status !== 429 && res.status < 500) throw err;
      lastErr = err;
      const ra = Number(res.headers.get('retry-after'));
      if (res.status === 429 && ra > 0) wait = ra * 1000;
    } catch (e) {
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
      lastErr = e;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(wait);
  }
  throw lastErr;
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

// ---------- CSV ----------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '') !== '');
}

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function productsFromCsv(text: string): Product[] {
  const [header, ...rows] = parseCsv(text);
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`CSV is missing column "${name}"`);
    return i;
  };
  const iHandle = col('Handle'), iSku = col('Variant SKU'), iSrc = col('Image Src'), iPos = col('Image Position');
  const products = new Map<string, Product>();
  for (const r of rows) {
    const handle = (r[iHandle] ?? '').trim();
    if (!handle) continue;
    let p = products.get(handle);
    if (!p) {
      // SKU comes from the first row of each handle
      p = { handle, variants: [{ id: 0, sku: (r[iSku] ?? '').trim() || null }], images: [] };
      products.set(handle, p);
    }
    const src = (r[iSrc] ?? '').trim();
    if (!src) continue;
    p.images.push({ src, position: Number(r[iPos]) || p.images.length + 1 });
  }
  return [...products.values()];
}

// ---------- Live ----------

async function fetchCollectionProducts(store: string, collection: string, country?: string): Promise<Product[]> {
  const base = collection === 'all' ? `${store}/products.json` : `${store}/collections/${encodeURIComponent(collection)}/products.json`;
  const all: Product[] = [];
  for (let page = 1; ; page++) {
    const res = await fetchRetry(`${base}?limit=250&page=${page}${country ? `&country=${encodeURIComponent(country)}` : ""}`, { headers: { accept: 'application/json' } });
    const { products } = (await res.json()) as { products: Product[] };
    if (!products.length) break;
    all.push(...products);
  }
  return all;
}

// ---------- Main ----------

async function download(job: Job): Promise<Status> {
  const path = join(job.dir, job.filename);
  try {
    if ((await stat(path)).size > 0) return 'skipped';
  } catch { /* not there yet */ }
  try {
    const res = await fetchRetry(job.sourceUrl);
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
    return 'downloaded';
  } catch (e) {
    console.error(`failed: ${job.sourceUrl}: ${e instanceof Error ? e.message : e}`);
    return 'failed';
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      store: { type: 'string' },
      collections: { type: 'string' },
      out: { type: 'string', default: './images' },
      csv: { type: 'string' },
      countries: { type: 'string' },
    },
  });
  const store = (values.store ?? '').replace(/\/+$/, '');
  const out = values.out!;
  if (!values.csv && (!values.collections || !store)) {
    console.error('Usage: export-images.ts --store URL --collections a,b|all [--out DIR] [--countries US,GB] | --csv products_export.csv');
    process.exit(2);
  }

  const countries = (values.countries ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const names = new NameAllocator();
  const jobs: Job[] = [];
  let productCount = 0;

  const addProducts = (collection: string, dirName: string, products: Product[]) => {
    const dir = join(out, dirName);
    productCount += products.length;
    for (const p of products) {
      for (const img of p.images) {
        const url = stripQuery(img.src);
        const sku = resolveSku(p, img);
        jobs.push({
          collection, handle: p.handle, sku, position: img.position, sourceUrl: url, dir,
          filename: names.allocate(dir, sku, img.position, extOf(url)),
        });
      }
    }
  };

  if (values.csv) {
    addProducts('csv-export', 'csv-export', productsFromCsv(await readFile(values.csv, 'utf8')));
  } else {
    for (const c of values.collections!.split(',').map((s) => s.trim()).filter(Boolean)) {
      // Shopify Markets can show different products per country, so merge across them by handle
      const byHandle = new Map<string, Product>();
      for (const country of countries.length ? countries : [undefined]) {
        for (const p of await fetchCollectionProducts(store, c, country)) if (!byHandle.has(p.handle)) byHandle.set(p.handle, p);
      }
      const products = [...byHandle.values()];
      console.log(`${c}: ${products.length} products`);
      if (!products.length) console.warn(`warning: collection "${c}" returned no products (wrong handle, empty, or not published to the online store?)`);
      addProducts(c, c, products);
    }
  }

  await mkdir(out, { recursive: true });
  for (const d of new Set(jobs.map((j) => j.dir))) await mkdir(d, { recursive: true });

  const results: Result[] = [];
  await runPool(jobs, CONCURRENCY, async (job) => {
    results.push({ job, status: await download(job) });
  });

  // keep manifest in discovery order
  const order = new Map(jobs.map((j, i) => [j, i]));
  results.sort((a, b) => order.get(a.job)! - order.get(b.job)!);
  const lines = ['collection,handle,sku,position,filename,source_url,status'];
  for (const { job: j, status } of results) {
    lines.push([j.collection, j.handle, j.sku, j.position, j.filename, j.sourceUrl, status].map(csvEscape).join(','));
  }
  await writeFile(join(out, 'manifest.csv'), lines.join('\n') + '\n');

  const count = (s: Status) => results.filter((r) => r.status === s).length;
  console.log('\nSummary');
  console.log(`  products found: ${productCount}`);
  console.log(`  images found:   ${jobs.length}`);
  console.log(`  downloaded:     ${count('downloaded')}`);
  console.log(`  skipped:        ${count('skipped')}`);
  console.log(`  failed:         ${count('failed')}`);
  if (count('failed')) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
