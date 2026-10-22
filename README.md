# wbl-exporter

Bulk-download Shopify product images for one or more collections. No 100-image cap: it pages through `products.json` until a page comes back empty. No login or API key is needed, since it reads the store's public storefront JSON.

Requires Node.js 22.6+. Dev dependencies (`typescript`, `@types/node`) are only for type-checking.

## Usage

```bash
npm run export -- --store https://example.com --collections summer-sale,new-arrivals
npm run export -- --store https://example.com --collections all --out ./images
npm run export -- --store https://example.com --collections some-handle --countries US,LK
npm run export -- --csv ./products_export.csv
```

| Flag | Meaning |
| --- | --- |
| `--store` | Store base URL (required unless `--csv`) |
| `--countries` | Comma-separated country codes; products are merged across them (see Markets below) |
| `--collections` | Comma-separated collection handles (required unless `--csv`). `all` uses `/products.json` |
| `--out` | Output directory (default `./images`) |
| `--csv` | Shopify `products_export.csv` to use instead of the live store |

Files go to `{out}/{collection-handle}/{SKU}_{position}.{ext}`, and `{out}/manifest.csv` lists every image (`collection, handle, sku, position, filename, source_url, status`). A summary is printed at the end, and the exit code is non-zero if any download failed.

Behaviour: 4 concurrent downloads, 3 attempts with exponential backoff, `Retry-After` honored on HTTP 429, and re-runs skip files that already exist with non-zero size. Duplicate filenames get `-2`, `-3` suffixes with a warning. Query strings are stripped from image URLs.

## SKU fallback rule

For each image the SKU is, in order:

1. the SKU of the first variant whose id is in the image's `variant_ids`;
2. otherwise the SKU of the product's first variant;
3. otherwise the product handle.

Unsafe filename characters (`/`, `\`, spaces, etc.) become `-`.

## CSV mode limitation

The Shopify product export has no collection column, so all files go to `{out}/csv-export/`. Rows with the same `Handle` form one product, and the `Variant SKU` from the product's first row is used for all its images (the CSV has no image-to-variant link, so rule 1 does not apply). Rows with an empty `Image Src` are skipped.

## Notes

Collections that exist but are not published to the Online Store sales channel return no products from the public endpoint; the tool warns when that happens.

## Markets

Stores using Shopify Markets can show a different product set per country, so a collection may look smaller from one location. Pass `--countries US,GB,LK` to fetch each market and merge the results by product handle.
