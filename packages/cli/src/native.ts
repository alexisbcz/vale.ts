/**
 * The native messaging host an editor or browser extension talks to.
 *
 * `host-install` writes three things: a config file saying where the `vale`
 * binary is, the host binary itself, and a manifest the browser reads. The
 * config file exists because a browser launching the host does not hand it the
 * user's shell environment, so the host cannot find Vale on its own.
 *
 * Windows keeps the manifest's location in the registry rather than on disk.
 * Nothing here does that: Bun has no registry binding, and the two functions
 * Go guards behind a build tag are no-ops on every other platform too. The
 * manifest is still written, so a user on Windows can register it by hand; see
 * `setManifestRegistry` below.
 */

import {
	fileExists,
	isWindows,
	mkdir,
	newE100,
	osName,
	platformAndArch,
	which,
	xdg,
	type CLIFlags,
} from "@vale-ts/core";
import { rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fetchArchive } from "./api.ts";
import { printSuccess } from "./term.ts";
import { fetchJSON, goJSON } from "./util.ts";

const NATIVE_HOST_NAME = "sh.vale.native";

const RELEASE_URL =
	"https://github.com/vale-cli/vale-native/releases/download";

const SUPPORTED_BROWSERS = ["chrome", "firefox", "opera", "chromium", "edge"];

const EXTENSION_BY_BROWSER: Record<string, string> = {
	chrome: "chrome-extension://kfmjcegeklidlnjoechfggipjjjahedj/",
};

/** The path to the native host's config file. */
export function nativeConfig(): string {
	const home = homedir();

	switch (osName()) {
		case "windows":
			return xdg.configFile(path.join("vale", "native", "config.json"));
		case "linux": {
			const p = path.join(home, ".config/vale/native/config.json");
			mkdir(path.dirname(p));
			return p;
		}
		case "darwin": {
			const p = path.join(
				home,
				"Library/Application Support/vale/native/config.json",
			);
			mkdir(path.dirname(p));
			return p;
		}
		default:
			throw new Error(`unsupported OS: ${osName()}`);
	}
}

/** An executable's name, with the extension Windows needs. */
export function execName(name: string): string {
	return isWindows() ? `${name}.exe` : name;
}

/** Where each browser keeps its native messaging manifests. */
function manifestDirs(): Record<string, string> {
	const home = homedir();

	switch (osName()) {
		case "linux":
			return {
				chrome: path.join(home, ".config/google-chrome/NativeMessagingHosts"),
				firefox: path.join(home, ".mozilla/native-messaging-hosts"),
				opera: path.join(home, ".config/google-chrome/NativeMessagingHosts"),
				chromium: path.join(home, ".config/chromium/NativeMessagingHosts"),
			};
		case "darwin":
			return {
				chrome: path.join(
					home,
					"Library/Application Support/Google/Chrome/NativeMessagingHosts",
				),
				firefox: path.join(
					home,
					"Library/Application Support/Mozilla/NativeMessagingHosts",
				),
				opera: path.join(
					home,
					"Library/Application Support/Google/Chrome/NativeMessagingHosts",
				),
				chromium: path.join(
					home,
					"Library/Application Support/Chromium/NativeMessagingHosts",
				),
				edge: path.join(
					home,
					"Library/Application Support/Microsoft Edge/NativeMessagingHosts",
				),
			};
		default:
			return {};
	}
}

/** Where the host binary and the browser's manifest go. */
function locations(browser: string): { appDir: string; manifestDir: string } {
	const cfg = nativeConfig();
	const appDir = path.dirname(cfg);

	if (isWindows()) return { appDir, manifestDir: "" };

	return { appDir, manifestDir: manifestDirs()[browser] ?? "" };
}

/** Records where the `vale` binary is, for a host with no shell environment. */
function writeNativeConfig(): string {
	const cfgFile = nativeConfig();

	const exe = which(["vale"]);
	if (exe === "") throw new Error('exec: "vale": executable file not found in $PATH');

	writeFileSync(cfgFile, JSON.stringify({ path: exe }), { mode: 0o600 });
	return cfgFile;
}

/** The newest release of the host, by tag. */
async function latestHostRelease(): Promise<string> {
	const body = await fetchJSON(
		"https://api.github.com/repos/vale-cli/vale-native/releases/latest",
	);
	const parsed = JSON.parse(body) as { tag_name?: string };
	return parsed.tag_name ?? "";
}

/** The archive to download for this platform. */
async function hostDownloadURL(): Promise<string> {
	const tag = await latestHostRelease();
	return `${RELEASE_URL}/${tag}/vale-native_${platformAndArch()}.zip`;
}

/**
 * Registers a manifest's location with Windows.
 *
 * Go writes `HKCU\\SOFTWARE\\...\\NativeMessagingHosts\\sh.vale.native`. There
 * is no registry access here, so this reports what it could not do rather than
 * claiming an install that a browser will not find.
 */
function setManifestRegistry(_browser: string, manifestPath: string): void {
	if (!isWindows()) return;
	throw new Error(
		"registering a native messaging host with the Windows registry is not " +
			`supported by this build; the manifest is at '${manifestPath}'`,
	);
}

function unsetManifestRegistry(_browser: string): void {
	// Nothing to undo on a platform that was never registered.
}

/** `vale host-install <browser>`. */
export async function installNativeHost(
	args: readonly string[],
	_flags: CLIFlags,
): Promise<void> {
	const browser = args[0];
	if (args.length !== 1 || browser === undefined) {
		throw newE100("host-install", new Error("missing argument 'browser'"));
	}
	if (!SUPPORTED_BROWSERS.includes(browser)) {
		throw newE100(
			"host-install",
			new Error(`invalid browser; must one of [${SUPPORTED_BROWSERS.join(" ")}]`),
		);
	}

	try {
		const cfgFile = writeNativeConfig();
		printSuccess(`wrote '${cfgFile}'`);

		const where = locations(browser);
		const hostURL = await hostDownloadURL();
		const exe = execName("vale-native");

		for (const file of [exe, "LICENSE", "README.md"]) {
			const fp = path.join(where.appDir, file);
			if (fileExists(fp)) rmSync(fp, { force: true });
		}

		await fetchArchive(hostURL, where.appDir);
		printSuccess(`fetched '${hostURL}'`);

		const extension = EXTENSION_BY_BROWSER[browser];
		if (extension === undefined) {
			throw new Error("no extension for the given browser");
		}

		const allowed = [extension];
		const devID = process.env[`VALE_DEV_${browser.toUpperCase()}_ID`];
		if (devID !== undefined) allowed.push(devID);

		const manifest: Record<string, unknown> = {
			name: NATIVE_HOST_NAME,
			description: "A native messaging for the Vale CLI.",
			path: path.join(where.appDir, exe),
			type: "stdio",
		};
		if (browser === "firefox") manifest.allowed_extensions = allowed;
		else manifest.allowed_origins = allowed;

		const manifestFile = path.join(
			where.manifestDir,
			`${NATIVE_HOST_NAME}.json`,
		);
		const body = goJSON(manifest, "  ");

		if (isWindows()) {
			const dir = path.join(path.dirname(nativeConfig()), "manifest", browser);
			mkdir(dir);
			const subdir = path.join(dir, path.basename(manifestFile));
			writeFileSync(subdir, body, { mode: 0o600 });
			setManifestRegistry(browser, subdir);
		} else {
			mkdir(path.dirname(manifestFile));
			writeFileSync(manifestFile, body, { mode: 0o600 });
		}

		printSuccess(`installed '${manifestFile}'`);
	} catch (err) {
		throw newE100("host-install", err);
	}
}

/** `vale host-uninstall <browser>`. */
export async function uninstallNativeHost(
	args: readonly string[],
	_flags: CLIFlags,
): Promise<void> {
	const browser = args[0];
	if (args.length !== 1 || browser === undefined) {
		throw newE100("host-uninstall", new Error("missing argument 'browser'"));
	}
	if (!SUPPORTED_BROWSERS.includes(browser)) {
		throw newE100(
			"host-uninstall",
			new Error(`invalid browser; must one of [${SUPPORTED_BROWSERS.join(" ")}]`),
		);
	}

	try {
		const where = locations(browser);

		for (const file of [
			"config.json",
			execName("vale-native"),
			"LICENSE",
			"README.md",
			"host.log",
		]) {
			const fp = path.join(where.appDir, file);
			if (fileExists(fp)) rmSync(fp, { force: true });
		}
		printSuccess("removing files");

		const manifestFile = path.join(
			where.manifestDir,
			`${NATIVE_HOST_NAME}.json`,
		);
		if (fileExists(manifestFile)) rmSync(manifestFile, { force: true });

		unsetManifestRegistry(browser);
		printSuccess("uninstalling host");
	} catch (err) {
		throw newE100("host-uninstall", err);
	}
}
