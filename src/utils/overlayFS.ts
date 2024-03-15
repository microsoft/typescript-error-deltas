import path from "path";
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
export async function createTempOverlayFS(root: string, diagnosticOutput: boolean): Promise<DisposableOverlayBaseFS> {
    await tryUnmount(root);
    await rmAsRootWithRetry(root);
    await mkdirAllAsRoot(root);
    await execAsync(processCwd, `sudo mount -t tmpfs -o size=4g tmpfs ${root}`);

    const lowerDir = path.join(root, "lower");
    await mkdirAll(lowerDir);

    let overlay: OverlayMergedFS | undefined;

    async function createOverlay(): Promise<OverlayMergedFS> {
        if (overlay) {
            throw new Error("Overlay has already been created");
        }

        const overlayRoot = path.join(root, "overlay");
        await rmAsRootWithRetry(overlayRoot);

        const upperDir = path.join(overlayRoot, "upper");
        const workDir = path.join(overlayRoot, "work");
        const merged = path.join(overlayRoot, "merged");
        
        await mkdirAll(upperDir, workDir, merged);

        if (diagnosticOutput) {
            await diskUsageRoot(lowerDir);
            await diskUsageRoot(overlayRoot);
        }

        await execAsync(processCwd, `sudo mount -t overlay overlay -o lowerdir=${lowerDir},upperdir=${upperDir},workdir=${workDir} ${merged}`);

        overlay = {
            path: merged,
            [Symbol.asyncDispose]: async () => {
                overlay = undefined;
                if (diagnosticOutput) {
                    await diskUsageRoot(upperDir);
                }
                await tryUnmount(merged);
                await rmAsRootWithRetry(overlayRoot);
            }
        }

        return overlay;
    }

    return {
        path: lowerDir,
        createOverlay,
        [Symbol.asyncDispose]: async () => {
            if (diagnosticOutput) {
                await diskUsageRoot(root);
            }
            if (overlay) {
                await overlay[Symbol.asyncDispose]();
            }
            await tryUnmount(root);
            await rmAsRootWithRetry(root);
        },  
    }
}

async function retry(fn: (() => void) | (() => Promise<void>), retries: number, delayMs: number): Promise<void> {
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

function diskUsageRoot(p: string) {
    return execAsync(processCwd, `sudo du -sh ${p}`);
}

function rmWithRetry(p: string) {
    return retry(() => execAsync(processCwd, `rm -rf ${p}`), 3, 1000);
}

function rmAsRootWithRetry(p: string) {
    return retry(() => execAsync(processCwd, `sudo rm -rf ${p}`), 3, 1000);
}

function mkdirAll(...args: string[]) {
    return execAsync(processCwd, `mkdir -p ${args.join(" ")}`);
}

function mkdirAllAsRoot(...args: string[]) {
    return execAsync(processCwd, `sudo mkdir -p ${args.join(" ")}`);
}

/**
 * Creates a fake overlay FS, which is just a directory on the local filesystem.
 * Overlays are created by copying the contents of the `base` directory.
 */
export async function createCopyingOverlayFS(root: string, _diagnosticOutput: boolean): Promise<DisposableOverlayBaseFS> {
    await rmWithRetry(root);
    await mkdirAll(root);

    const basePath = path.join(root, "base");
    await mkdirAll(basePath);

    let overlay: OverlayMergedFS | undefined;

    async function createOverlay(): Promise<OverlayMergedFS> {
        if (overlay) {
            throw new Error("Overlay has already been created");
        }

        const overlayRoot = path.join(root, "overlay");
        await rmWithRetry(overlayRoot);

        await execAsync(processCwd, `cp -r --reflink=auto ${basePath} ${overlayRoot}`);

        overlay = {
            path: overlayRoot,
            [Symbol.asyncDispose]: async () => {
                overlay = undefined;
                await rmWithRetry(overlayRoot);
            }
        }

        return overlay;
    }

    return {
        path: basePath,
        createOverlay,
        [Symbol.asyncDispose]: async () => {
            if (overlay) {
                await overlay[Symbol.asyncDispose]();
                overlay = undefined;
            }
            await rmWithRetry(root);
        },  
    }
}
