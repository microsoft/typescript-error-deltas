import path from "path";
import fs from "fs";
import { execAsync } from "./execUtils";

export interface OverlayBaseFS {
    path: string;
    createOverlay(): Promise<OverlayMergedFS>;
}

export interface OverlayMergedFS extends AsyncDisposable {
    path: string;
}

export interface DisposableOverlayBaseFS extends OverlayBaseFS, AsyncDisposable {}

const processCwd = process.cwd();

/**
 * Creates an overlay FS using a tmpfs mount. A base directory is created on the tmpfs.
 * New overlays are created by mounting an overlay on top of the base directory.
 * 
 * This requires root access.
 */
export async function createTempOverlayFS(root: string): Promise<DisposableOverlayBaseFS> {
    await tryUnmount(root);
    await retryRm(root);
    await mkdirAll(root);
    await execAsync(processCwd, `sudo mount -t tmpfs -o size=4g tmpfs ${root}`);

    const basePath = path.join(root, "base");
    await mkdirAll(basePath);

    let overlayCount = 0;
    let overlays: (AsyncDisposable | undefined)[] = [];

    async function createOverlay(): Promise<OverlayMergedFS> {
        const overlayId = overlayCount++;

        const overlayRoot = path.join(root, `overlay-${overlayId}`);
        const upperDir = path.join(overlayRoot, "upper");
        const workDir = path.join(overlayRoot, "work");
        const merged = path.join(overlayRoot, "merged");

        await mkdirAll(upperDir, workDir, merged);

        await execAsync(processCwd, `sudo mount -t overlay overlay -o lowerdir=${basePath},upperdir=${upperDir},workdir=${workDir} ${merged}`);

        const overlay: OverlayMergedFS = {
            path: merged,
            [Symbol.asyncDispose]: async () => {
                overlays[overlayId] = undefined;
                await tryUnmount(merged);
                await retryRm(overlayRoot);
            }
        }

        overlays[overlayId] = overlay;
        return overlay;
    }

    return {
        path: basePath,
        createOverlay,
        [Symbol.asyncDispose]: async () => {
            for (const overlay of overlays) {
                if (overlay) {
                    await overlay[Symbol.asyncDispose]();
                }
            }
            await tryUnmount(root);
            await retryRm(root);
        },  
    }
}

async function retry(fn: () => void | Promise<void>, retries: number, delayMs: number): Promise<void> {
    for (let i = 0; i < retries; i++) {
        try {
            await fn();
            return;
        } catch (e) {
            if (i === retries - 1) {
                throw e;
            }
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

async function tryUnmount(p: string) {
    try {
        await execAsync(processCwd, `sudo umount -R ${p}`)
    } catch {
        // ignore
    }
}

function retryRm(p: string) {
    return retry(() => fs.promises.rm(p, { recursive: true, force: true }), 3, 1000);
}

async function mkdirAll(...args: string[]) {
    for (const p of args) {
        await fs.promises.mkdir(p, { recursive: true });
    }
}

/**
 * Creates a fake overlay FS, which is just a directory on the local filesystem.
 * Overlays are created by copying the contents of the `base` directory.
 */
export async function createCopyingOverlayFS(root: string): Promise<DisposableOverlayBaseFS> {
    await retryRm(root);
    await mkdirAll(root);

    const basePath = path.join(root, "base");
    await mkdirAll(basePath);

    let overlayCount = 0;
    let overlays: (AsyncDisposable | undefined)[] = [];

    async function createOverlay(): Promise<OverlayMergedFS> {
        const overlayId = overlayCount++;

        const overlayRoot = path.join(root, `overlay-${overlayId}`);
        await retryRm(overlayRoot);

        await execAsync(processCwd, `cp -r ${basePath} ${overlayRoot}`);

        const overlay: OverlayMergedFS = {
            path: overlayRoot,
            [Symbol.asyncDispose]: async () => {
                overlays[overlayId] = undefined;
                await retryRm(overlayRoot);
            }
        }

        overlays[overlayId] = overlay;
        return overlay;
    }

    return {
        path: basePath,
        createOverlay,
        [Symbol.asyncDispose]: async () => {
            for (const overlay of overlays) {
                if (overlay) {
                    await overlay[Symbol.asyncDispose]();
                }
            }
            await retryRm(root);
        },  
    }
}
