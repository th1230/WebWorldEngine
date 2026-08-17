import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(here, '..', '..', '..');
export const APP_ROOT = path.join(REPO_ROOT, 'apps', 'benchmark');
export const RESULTS_DIR = path.join(REPO_ROOT, 'benchmarks', 'results');
export const BASELINES_DIR = path.join(REPO_ROOT, 'benchmarks', 'baselines');
