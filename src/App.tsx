import { useEffect, useMemo, useState } from "react";

const GITHUB_REPO_URL = "https://github.com/amir-s/rakh";
const RELEASES_API_URL =
  "https://api.github.com/repos/amir-s/rakh/releases/latest";
const RELEASES_PAGE_URL = `${GITHUB_REPO_URL}/releases`;
const ICON_SRC = "/icon.png";
const SCREENSHOT_SRC = "/screenshot.png";
const BATTERY_ROWS = [
  [
    "tools",
    "subagents",
    "integrations",
    "shell access",
    "durable artifacts",
    "voice input",
  ],
  [
    "multiple providers",
    "parallel agents with git worktrees",
    "skills",
    "code review",
    "permissions",
  ],
];

type ReleaseAsset = {
  browser_download_url: string;
  download_count: number;
  name: string;
  size: number;
};

type ReleasePayload = {
  assets: ReleaseAsset[];
  html_url: string;
  tag_name: string;
};

type ClientArch = "arm64" | "unknown" | "x64";
type ClientPlatform = "linux" | "macos" | "unknown" | "windows";

type ClientTarget = {
  arch: ClientArch;
  platform: ClientPlatform;
};

type NavigatorUADataLike = {
  getHighEntropyValues?: (
    hints: string[],
  ) => Promise<{ architecture?: string; platform?: string }>;
  mobile?: boolean;
  platform?: string;
};

type NavigatorWithUAData = Navigator & {
  userAgentData?: NavigatorUADataLike;
};

function formatVersion(tag: string) {
  return tag.replace(/^rakh-/, "");
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizePlatform(value: string | undefined) {
  const normalized = value?.toLowerCase() ?? "";

  if (
    normalized.includes("mac") ||
    normalized.includes("darwin") ||
    normalized.includes("os x")
  ) {
    return "macos" satisfies ClientPlatform;
  }

  if (normalized.includes("win")) {
    return "windows" satisfies ClientPlatform;
  }

  if (
    normalized.includes("linux") ||
    normalized.includes("ubuntu") ||
    normalized.includes("x11")
  ) {
    return "linux" satisfies ClientPlatform;
  }

  return "unknown" satisfies ClientPlatform;
}

function normalizeArch(value: string | undefined) {
  const normalized = value?.toLowerCase() ?? "";

  if (normalized.includes("arm") || normalized.includes("aarch")) {
    return "arm64" satisfies ClientArch;
  }

  if (
    normalized.includes("x64") ||
    normalized.includes("x86_64") ||
    normalized.includes("amd64") ||
    normalized.includes("intel") ||
    normalized.includes("win64")
  ) {
    return "x64" satisfies ClientArch;
  }

  return "unknown" satisfies ClientArch;
}

function detectLegacyTarget() {
  const source = `${navigator.userAgent} ${navigator.platform}`;

  return {
    platform: normalizePlatform(source),
    arch: normalizeArch(source),
  } satisfies ClientTarget;
}

async function detectClientTarget() {
  const fallback = detectLegacyTarget();
  const navigatorWithUA = navigator as NavigatorWithUAData;
  const uaData = navigatorWithUA.userAgentData;

  if (!uaData || uaData.mobile) {
    return fallback;
  }

  let platform = fallback.platform;
  let arch = fallback.arch;

  const hintedPlatform = normalizePlatform(uaData.platform);
  if (hintedPlatform !== "unknown") {
    platform = hintedPlatform;
  }

  if (uaData.getHighEntropyValues) {
    try {
      const values = await uaData.getHighEntropyValues([
        "architecture",
        "platform",
      ]);
      const detectedPlatform = normalizePlatform(values.platform);
      const detectedArch = normalizeArch(values.architecture);

      if (detectedPlatform !== "unknown") {
        platform = detectedPlatform;
      }

      if (detectedArch !== "unknown") {
        arch = detectedArch;
      }
    } catch (error) {
      console.error(error);
    }
  }

  return { platform, arch } satisfies ClientTarget;
}

function assetPriority(asset: ReleaseAsset) {
  const name = asset.name.toLowerCase();

  if (name.endsWith(".dmg")) return 0;
  if (name.endsWith(".exe")) return 1;
  if (name.endsWith(".appimage")) return 2;
  if (name.endsWith(".msi")) return 3;
  if (name.endsWith(".deb")) return 4;
  if (name.endsWith(".rpm")) return 5;
  if (name.endsWith(".app.tar.gz")) return 6;

  return 7;
}

function assetPlatform(asset: ReleaseAsset) {
  const name = asset.name.toLowerCase();

  if (name.endsWith(".dmg") || name.endsWith(".app.tar.gz")) {
    return "macos" satisfies ClientPlatform;
  }

  if (name.endsWith(".exe") || name.endsWith(".msi")) {
    return "windows" satisfies ClientPlatform;
  }

  if (
    name.endsWith(".appimage") ||
    name.endsWith(".deb") ||
    name.endsWith(".rpm")
  ) {
    return "linux" satisfies ClientPlatform;
  }

  return "unknown" satisfies ClientPlatform;
}

function assetArch(asset: ReleaseAsset) {
  const name = asset.name.toLowerCase();

  if (name.includes("aarch64") || name.includes("arm64")) {
    return "arm64" satisfies ClientArch;
  }

  if (
    name.includes("x64") ||
    name.includes("x86_64") ||
    name.includes("amd64") ||
    name.includes("intel")
  ) {
    return "x64" satisfies ClientArch;
  }

  return "unknown" satisfies ClientArch;
}

function platformLabel(platform: ClientPlatform) {
  if (platform === "macos") return "macOS";
  if (platform === "windows") return "Windows";
  if (platform === "linux") return "Linux";
  return "Latest Release";
}

function assetLabel(asset: ReleaseAsset) {
  const name = asset.name.toLowerCase();

  if (name.endsWith(".dmg")) {
    return name.includes("aarch64") ? "Apple Silicon DMG" : "Intel DMG";
  }

  if (name.endsWith(".app.tar.gz")) {
    return name.includes("aarch64") ? "Apple Silicon Archive" : "Intel Archive";
  }

  if (name.endsWith(".exe")) return "Setup EXE";
  if (name.endsWith(".msi")) return "MSI";
  if (name.endsWith(".appimage")) return "AppImage";
  if (name.endsWith(".deb")) return "DEB";
  if (name.endsWith(".rpm")) return "RPM";

  return asset.name;
}

function assetSummary(asset: ReleaseAsset) {
  return `${platformLabel(assetPlatform(asset))} ${assetLabel(asset)}`;
}

function primaryButtonLabel(
  primaryAsset: ReleaseAsset | null,
  suggestedAsset: ReleaseAsset | null,
  target: ClientTarget,
) {
  if (suggestedAsset) {
    return `Download for ${platformLabel(target.platform)}`;
  }

  if (primaryAsset) {
    return "Download latest release";
  }

  return "Open GitHub release";
}

type IconProps = {
  className?: string;
};

function GitHubMark({ className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.25.45-2.28 1.18-3.08-.12-.3-.51-1.5.11-3.13 0 0 .97-.31 3.17 1.18a10.9 10.9 0 0 1 5.77 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.63.24 2.83.12 3.13.74.8 1.18 1.83 1.18 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.09.78 2.2 0 1.59-.01 2.87-.01 3.25 0 .31.21.68.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

function DownloadMark({ className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 4v10" />
      <path d="m8 10 4 4 4-4" />
      <path d="M4 18h16" />
    </svg>
  );
}

function StackMark({ className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" />
      <path d="m4 12.5 8 4.5 8-4.5" />
      <path d="m4 17 8 4.5 8-4.5" />
    </svg>
  );
}

function ChevronDownMark({ className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function pickSuggestedAsset(
  assets: ReleaseAsset[],
  target: ClientTarget,
): ReleaseAsset | null {
  if (target.platform === "unknown") {
    return null;
  }

  if (target.platform === "macos" && target.arch === "unknown") {
    return null;
  }

  const candidates = assets.filter(
    (asset) => assetPlatform(asset) === target.platform,
  );
  if (candidates.length === 0) {
    return null;
  }

  return [...candidates].sort((left, right) => {
    const leftArch = assetArch(left);
    const rightArch = assetArch(right);
    const leftArchScore =
      leftArch === target.arch ? 0 : leftArch === "unknown" ? 1 : 2;
    const rightArchScore =
      rightArch === target.arch ? 0 : rightArch === "unknown" ? 1 : 2;

    if (leftArchScore !== rightArchScore) {
      return leftArchScore - rightArchScore;
    }

    return assetPriority(left) - assetPriority(right);
  })[0];
}

function compareAssets(left: ReleaseAsset, right: ReleaseAsset) {
  const platformOrder: Record<ClientPlatform, number> = {
    macos: 0,
    windows: 1,
    linux: 2,
    unknown: 3,
  };

  const platformDelta =
    platformOrder[assetPlatform(left)] - platformOrder[assetPlatform(right)];
  if (platformDelta !== 0) {
    return platformDelta;
  }

  return assetPriority(left) - assetPriority(right);
}

export default function App() {
  const [clientTarget, setClientTarget] = useState<ClientTarget>({
    arch: "unknown",
    platform: "unknown",
  });
  const [release, setRelease] = useState<ReleasePayload | null>(null);
  const [status, setStatus] = useState<"error" | "loading" | "ready">(
    "loading",
  );

  useEffect(() => {
    let cancelled = false;

    void detectClientTarget().then((target) => {
      if (!cancelled) {
        setClientTarget(target);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function loadLatestRelease() {
      try {
        const response = await fetch(RELEASES_API_URL, {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(
            `GitHub Releases request failed with ${response.status}`,
          );
        }

        const payload = (await response.json()) as ReleasePayload;
        setRelease(payload);
        setStatus("ready");
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        console.error(error);
        setStatus("error");
      }
    }

    void loadLatestRelease();

    return () => controller.abort();
  }, []);

  const sortedAssets = useMemo(
    () => (release ? [...release.assets].sort(compareAssets) : []),
    [release],
  );

  const suggestedAsset = useMemo(
    () => (release ? pickSuggestedAsset(release.assets, clientTarget) : null),
    [clientTarget, release],
  );

  const primaryAsset = useMemo(
    () => suggestedAsset ?? sortedAssets[0] ?? null,
    [sortedAssets, suggestedAsset],
  );

  const secondaryAssets = useMemo(
    () => sortedAssets.filter((asset) => asset.name !== primaryAsset?.name),
    [sortedAssets, primaryAsset],
  );

  const releaseLink = release?.html_url ?? RELEASES_PAGE_URL;
  const primaryHref = primaryAsset?.browser_download_url ?? releaseLink;
  const badgeText = release
    ? `${formatVersion(release.tag_name)} is out now`
    : "Latest release on GitHub";

  return (
    <div className="min-h-screen bg-ink-950 text-white">
      <main className="mx-auto flex h-svh w-full max-w-7xl flex-col overflow-hidden px-6 pb-0 pt-5 sm:px-10 sm:pt-6">
        <header className="flex items-center justify-between border-b border-white/10 pb-4">
          <div className="flex items-center gap-3 text-white">
            <img alt="" className="h-8 w-8" src={ICON_SRC} />
            <span className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
              Rakh
            </span>
          </div>

          <a
            className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.28em] text-white/58 transition hover:text-brand-300 sm:text-sm"
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noreferrer"
          >
            <GitHubMark className="h-4 w-4" />
            GitHub
          </a>
        </header>

        <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center pt-10 text-center sm:pt-12">
          <div className="inline-flex items-center gap-3 rounded-full border border-brand-400/25 bg-brand-500/8 px-3.5 py-1.5 shadow-[0_0_24px_rgba(43,108,238,0.12)]">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400/80" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand-400" />
            </span>
            <a
              className="text-[11px] uppercase tracking-[0.34em] text-brand-300 transition hover:text-brand-200"
              href={`${GITHUB_REPO_URL}/blob/main/CHANGELOG.md`}
              target="_blank"
              rel="noreferrer"
            >
              {badgeText}
            </a>
          </div>

          <h1 className="mt-6 max-w-3xl font-display text-5xl font-semibold tracking-[-0.06em] text-white sm:text-7xl">
            Rakh
            <span className="ml-2 inline-block text-brand-400">sh</span>
          </h1>

          <div className="mt-5 flex max-w-3xl flex-col items-center gap-2.5 text-center">
            <p className="text-sm leading-7 text-white/68 sm:text-xl sm:leading-9">
              Open source AI coding agent with{" "}
              <span className="group/batteries relative inline-flex align-baseline">
                <button
                  type="button"
                  className="inline-flex items-center rounded-xl border border-brand-400/30 bg-brand-500/10 px-2 py-0.5 text-brand-300 transition hover:border-brand-300 hover:bg-brand-500/16 hover:text-white focus:outline-none focus-visible:border-brand-300 focus-visible:bg-brand-500/18 focus-visible:text-white sm:px-2.5"
                >
                  batteries
                </button>

                <span className="pointer-events-none absolute left-1/2 top-full z-30 mt-3 w-[min(28rem,calc(100vw-3rem))] -translate-x-1/2 opacity-0 transition duration-200 group-hover/batteries:pointer-events-auto group-hover/batteries:opacity-100 group-focus-within/batteries:pointer-events-auto group-focus-within/batteries:opacity-100">
                  <span className="block overflow-hidden rounded-[1.35rem] border border-brand-400/20 bg-ink-900/96 p-3 text-left shadow-[0_24px_80px_rgba(0,0,0,0.52)] backdrop-blur-xl">
                    <span className="marquee-fade block overflow-hidden rounded-2xl ">
                      {BATTERY_ROWS.map((row, rowIndex) => (
                        <span
                          key={row.join("-")}
                          className={`marquee-track ${
                            rowIndex === 1 ? "marquee-track--reverse mt-2" : ""
                          }`}
                        >
                          {[...row, ...row].map((item, itemIndex) => (
                            <span
                              key={`${rowIndex}-${itemIndex}-${item}`}
                              className="mr-2 inline-flex rounded-xl border border-white/8 bg-white/4 px-2.5  text-[10px] uppercase tracking-[0.18em] text-white/66"
                            >
                              {item}
                            </span>
                          ))}
                        </span>
                      ))}
                    </span>
                  </span>
                </span>
              </span>{" "}
              included.
            </p>
            <p className="max-w-2xl text-[10px] leading-5 text-white/34 sm:text-xs sm:leading-5">
              Named after{" "}
              <a
                href="https://en.wikipedia.org/wiki/Rakhsh"
                className="text-brand-400 underline underline-offset-2"
              >
                Rakhsh
              </a>
              , Rostam’s legendary steed in the Shahnameh.
            </p>
          </div>

          <div className="mt-7 flex w-full max-w-3xl flex-col items-center justify-center gap-2 sm:flex-row">
            {status === "loading" ? (
              <div className="flex w-full flex-col gap-2 sm:flex-row">
                <span className="inline-flex min-h-12 w-full items-center justify-center rounded-2xl border border-brand-400/40 bg-brand-500/10 px-5 py-3 text-xs uppercase tracking-[0.2em] text-brand-200/85 sm:flex-1 sm:text-sm">
                  Pulling latest release...
                </span>
                <a
                  className="inline-flex min-h-12 w-full items-center justify-center rounded-2xl border border-white/12 bg-white/[0.02] px-5 py-3 text-xs uppercase tracking-[0.2em] text-white/66 transition hover:border-white/20 hover:text-white sm:w-auto sm:text-sm"
                  href={releaseLink}
                  target="_blank"
                  rel="noreferrer"
                >
                  View releases
                </a>
              </div>
            ) : null}

            {status !== "loading" ? (
              <>
                <a
                  className="inline-flex min-h-12 w-full items-center justify-center gap-2.5 rounded-2xl border border-brand-400/50 bg-brand-500/10 px-5 py-3 text-xs font-medium uppercase tracking-[0.2em] text-brand-200 transition hover:border-brand-300 hover:bg-brand-500/16 hover:text-white sm:flex-1 sm:text-sm"
                  href={primaryHref}
                  target="_blank"
                  rel="noreferrer"
                >
                  <DownloadMark className="h-4 w-4" />
                  {primaryButtonLabel(
                    primaryAsset,
                    suggestedAsset,
                    clientTarget,
                  )}
                </a>

                {secondaryAssets.length > 0 ? (
                  <details className="group relative w-full sm:w-auto">
                    <summary className="inline-flex min-h-12 w-full list-none items-center justify-center gap-2.5 rounded-2xl border border-white/12 bg-white/[0.02] px-5 py-3 text-xs font-medium uppercase tracking-[0.2em] text-white/70 transition hover:border-white/20 hover:text-white [&::-webkit-details-marker]:hidden sm:text-sm">
                      <StackMark className="h-4 w-4" />
                      <span>Other downloads</span>
                      <ChevronDownMark className="h-4 w-4 transition group-open:rotate-180" />
                    </summary>

                    <div className="absolute left-1/2 top-full z-20 mt-2 flex w-[min(22rem,calc(100vw-3rem))] -translate-x-1/2 flex-col rounded-[1.25rem] border border-white/10 bg-ink-900/96 p-2 text-left shadow-[0_32px_80px_rgba(0,0,0,0.52)] backdrop-blur-xl sm:left-auto sm:right-0 sm:translate-x-0">
                      <div className="downloads-scroll flex max-h-[14rem] flex-col gap-1 overflow-y-auto pr-1">
                        {secondaryAssets.map((asset) => (
                          <a
                            key={asset.name}
                            className="rounded-[0.95rem] border border-white/8 bg-white/[0.03] px-2.5 py-2 transition hover:border-brand-300/40 hover:bg-white/[0.06]"
                            href={asset.browser_download_url}
                            target="_blank"
                            rel="noreferrer"
                            title={assetSummary(asset)}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <span className="block truncate text-[11px] leading-5 text-white/86 sm:text-xs">
                                  {assetLabel(asset)}
                                </span>
                              </div>
                              <div className="flex shrink-0 flex-col items-end gap-1">
                                <span className="inline-flex rounded-full border border-brand-400/20 bg-brand-500/8 px-1.5 py-0.5 text-[8px] uppercase tracking-[0.22em] text-brand-300/90">
                                  {platformLabel(assetPlatform(asset))}
                                </span>
                                <span className="text-[10px] text-white/38">
                                  {formatSize(asset.size)}
                                </span>
                              </div>
                            </div>
                          </a>
                        ))}
                      </div>

                      <a
                        className="mt-1.5 inline-flex items-center justify-center rounded-[0.95rem] border border-white/10 px-3 py-2 text-[11px] uppercase tracking-[0.18em] text-white/64 transition hover:border-white/18 hover:text-white"
                        href={releaseLink}
                        target="_blank"
                        rel="noreferrer"
                      >
                        All releases
                      </a>
                    </div>
                  </details>
                ) : (
                  <a
                    className="inline-flex min-h-12 w-full items-center justify-center rounded-2xl border border-white/12 bg-white/[0.02] px-5 py-3 text-xs uppercase tracking-[0.2em] text-white/66 transition hover:border-white/20 hover:text-white sm:w-auto sm:text-sm"
                    href={releaseLink}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View releases
                  </a>
                )}
              </>
            ) : null}
          </div>
        </section>

        <section className="relative mx-auto mt-4 flex min-h-0 w-full max-w-7xl flex-1 items-start justify-center overflow-hidden sm:mt-6">
          <div className="pointer-events-none absolute inset-x-12 top-4 h-24 rounded-full bg-brand-500/10 blur-3xl" />
          <img
            alt="Rakh application screenshot"
            className="pointer-events-none block h-auto w-full max-w-full object-contain object-top select-none [mask-image:linear-gradient(to_bottom,black_0%,black_58%,rgba(0,0,0,0.68)_78%,transparent_100%)] [-webkit-mask-image:linear-gradient(to_bottom,black_0%,black_58%,rgba(0,0,0,0.68)_78%,transparent_100%)]"
            loading="lazy"
            src={SCREENSHOT_SRC}
          />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-b from-transparent via-ink-950/78 to-ink-950 sm:h-36" />
        </section>
      </main>
    </div>
  );
}
