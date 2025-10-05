const LS_KEY = "multiHlsUrls";
const players = new Map(); // id -> { hls, video, url, tile, backoffMs, lastTime, healthTimer, needsHeal }
const streamEntries = []; // duplicates allowed; each entry: { url, instanceId }

const grid = document.getElementById("grid");
const input = document.getElementById("urlInput");
const addBtn = document.getElementById("addBtn");
const clearBtn = document.getElementById("clearBtn");
const toolbar = document.getElementById("toolbar");
const feedSelector = document.getElementById("feedSelector");
const settingsBtn = document.getElementById("settingsBtn");
// token used to cancel/ignore in-flight preset loaders (especially the async 9now probe)
let presetLoadToken = 0;
const SETTINGS_KEY = "mv_settings";
let settings = {
	showDebugByDefault: false,
	autoplayMuted: true,
	showSubtitlesByDefault: false,
};
// When showSubtitlesByDefault is enabled, mark tiles with _autoSubtitle=true
// so we can select the first available subtitle track (HLS then native).

function loadSettings() {
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object")
			settings = Object.assign(settings, parsed);
	} catch {}
}

// Enable/disable toolbar controls depending on view mode
function updateToolbarState() {
	try {
		const isCustom = feedSelector && feedSelector.value === "custom";
		if (input) input.disabled = !isCustom;
		if (addBtn) addBtn.disabled = !isCustom;
		if (clearBtn) clearBtn.disabled = !isCustom;
		// create/position overlay to visually block the input+buttons when not custom
		try {
			let overlay = toolbar.querySelector(".toolbar-disabled-overlay");
			if (!overlay) {
				overlay = document.createElement("div");
				overlay.className = "toolbar-disabled-overlay";
				toolbar.appendChild(overlay);
			}
			if (!isCustom) {
				// position overlay to cover url input + add + clear buttons area
				const first = input; // left bound after selector
				const last = clearBtn; // right bound
				const rectToolbar = toolbar.getBoundingClientRect();
				const rectFirst = first.getBoundingClientRect();
				const rectLast = last.getBoundingClientRect();
				// compute offsets relative to toolbar
				const left = rectFirst.left - rectToolbar.left - 2; // slight inset
				const right = rectToolbar.right - rectLast.right - 2;
				const width = rectLast.right - rectFirst.left + 4;
				const top = rectFirst.top - rectToolbar.top - 2;
				const height = rectFirst.height + 4;
				overlay.style.left = left + "px";
				overlay.style.top = top + "px";
				overlay.style.width = width + "px";
				overlay.style.height = height + "px";
				overlay.classList.add("visible");
				// mask input text for clarity
				try {
					input.classList.add("masked");
				} catch {}
			} else {
				overlay.classList.remove("visible");
				try {
					input.classList.remove("masked");
				} catch {}
			}
		} catch (e) {}
	} catch {}
}

// reposition overlay on resize/toolbar changes
window.addEventListener("resize", () => {
	try {
		const overlay = toolbar.querySelector(".toolbar-disabled-overlay");
		if (overlay && overlay.classList.contains("visible")) updateToolbarState();
	} catch {}
});

function saveSettings() {
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	} catch {}
}

// create a simple settings menu when clicking the settings button
if (settingsBtn) {
	settingsBtn.addEventListener("click", (e) => {
		try {
			const existing = document.querySelector(".settings-menu");
			if (existing) {
				existing.remove();
				settingsBtn.setAttribute("aria-expanded", "false");
				return;
			}
			const menu = document.createElement("div");
			menu.className = "menu settings-menu";
			const ul = document.createElement("ul");

			const addCheckbox = (key, label) => {
				const li = document.createElement("li");
				const cb = document.createElement("input");
				cb.type = "checkbox";
				cb.id = "s-" + key;
				cb.checked = !!settings[key];
				cb.addEventListener("change", () => {
					// Persist the preference but do NOT mutate any existing players.
					// "By default" settings affect only page load and newly-created tiles.
					settings[key] = !!cb.checked;
					saveSettings();
				});
				const lbl = document.createElement("label");
				lbl.htmlFor = cb.id;
				lbl.style.marginLeft = "8px";
				lbl.textContent = label;
				li.style.display = "flex";
				li.style.alignItems = "center";
				li.style.gap = "8px";
				li.appendChild(cb);
				li.appendChild(lbl);
				ul.appendChild(li);
			};

			addCheckbox("showDebugByDefault", "Show debug panel by default");
			addCheckbox("autoplayMuted", "Autoplay streams muted");
			// persistent global default for subtitles
			addCheckbox("showSubtitlesByDefault", "Show subtitles by default");

			menu.appendChild(ul);
			// position near the settingsBtn
			menu.style.visibility = "hidden";
			// append to toolbar (toolbar is position:relative) so the menu is never clipped
			try {
				toolbar.appendChild(menu);
			} catch {
				document.body.appendChild(menu);
			}
			// place just below the toolbar, aligned to the right
			menu.style.position = "absolute";
			menu.style.top = `${toolbar.offsetHeight + 6}px`;
			menu.style.right = "6px";
			menu.style.left = "auto";
			menu.style.visibility = "";
			settingsBtn.setAttribute("aria-expanded", "true");
			const off = (ev) => {
				if (!menu.contains(ev.target) && ev.target !== settingsBtn) {
					menu.remove();
					settingsBtn.setAttribute("aria-expanded", "false");
					document.removeEventListener("click", off);
				}
			};
			setTimeout(() => document.addEventListener("click", off));
		} catch (e) {}
	});
}

// apply settings when creating tiles (used in addStreamTile)

// restore saved view mode (persist between reloads)
try {
	const saved = localStorage.getItem("mv_viewMode");
	if (saved && feedSelector) feedSelector.value = saved;
} catch {}

if (feedSelector) {
	feedSelector.addEventListener("change", () => {
		try {
			localStorage.setItem("mv_viewMode", feedSelector.value);
		} catch {}
		// enable/disable toolbar controls immediately
		try {
			updateToolbarState();
		} catch {}
		const mode = feedSelector.value;
		if (mode === "custom") {
			// cancel any in-flight preset loaders
			try {
				presetLoadToken++;
			} catch {}
			// restore any saved custom streams from localStorage
			try {
				removeAllTiles(false);
				streamEntries.length = 0;
				const saved = loadList();
				if (saved && saved.length) {
					saved.forEach((entry) => {
						streamEntries.push(entry);
						addStreamTile(entry.url, entry.instanceId);
					});
				} else {
					updateEmptyState();
				}
				layoutGrid();
			} catch {}
			return;
		}
		loadPresets(mode);
	});
}

// When ch9 mode is selected, show all city labels only while the pointer is
// directly over a tile. Previously we showed labels for any pointer inside
// the grid which left labels visible when the cursor was between tiles.
// Use pointermove to detect when the pointer is over a .tile and pointerleave
// to clear the state when leaving the grid entirely.
grid.addEventListener("pointermove", (e) => {
	try {
		if (!feedSelector || feedSelector.value !== "ch9") return;
		const overTile =
			!!e.target && !!e.target.closest && e.target.closest(".tile");
		if (overTile) grid.classList.add("show-all-labels");
		else grid.classList.remove("show-all-labels");
	} catch {}
});
grid.addEventListener("pointerleave", () => {
	try {
		if (feedSelector && feedSelector.value === "ch9")
			grid.classList.remove("show-all-labels");
	} catch {}
});

addBtn.addEventListener("click", () => {
	const raw = input.value.trim();
	if (!raw) return;
	// accept only the first URL token
	const first = raw.split(/[,\s]+/)[0].trim();
	if (!first) return;
	addUrls([first]);
	input.value = "";
});
input.addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		addBtn.click();
	}
});
clearBtn.addEventListener("click", () => {
	removeAllTiles();
	saveList();
	layoutGrid();
});

function addUrls(urls) {
	let added = 0;
	urls.forEach((u) => {
		if (!u) return;
		const entry = { url: u, instanceId: crypto.randomUUID() };
		streamEntries.push(entry);
		addStreamTile(entry.url, entry.instanceId);
		added++;
	});
	if (added > 0) {
		try {
			localStorage.setItem("mv_viewMode", "custom");
		} catch {}
		saveList();
		layoutGrid();
	}
	updateEmptyState();
}
function saveList() {
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(streamEntries));
	} catch {}
}
function loadList() {
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (!raw) return [];
		const arr = JSON.parse(raw);
		if (!Array.isArray(arr)) return []; // normalize legacy string arrays
		// legacy stored arrays might be strings; map to entries
		if (arr.length && typeof arr[0] === "string") {
			const converted = arr.map((s) => ({
				url: s,
				instanceId: crypto.randomUUID(),
			}));
			// persist normalized form
			try {
				localStorage.setItem(LS_KEY, JSON.stringify(converted));
			} catch {}
			return converted;
		}
		return arr.filter(Boolean);
	} catch {
		return [];
	}
}

// Preset feed loader: supports '9now', 'ch9', and 'custom'
function loadPresets(mode) {
	try {
		// clear existing tiles and entries (do not overwrite persisted custom list)
		removeAllTiles(false);
		streamEntries.length = 0;
		layoutGrid();
	} catch {}

	try {
		localStorage.setItem("mv_viewMode", mode);
	} catch {}
	if (!mode || mode === "custom") return;

	if (mode === "ch9") {
		// map city codes to friendly names
		const cityMap = {
			syd: "Sydney",
			mel: "Melbourne",
			bne: "Brisbane",
			adl: "Adelaide",
			per: "Perth",
			new: "Newcastle",
			nlm: "Northern Rivers",
			gcq: "Gold Coast",
		};
		// city codes used by original index.html
		const cities = ["syd", "mel", "bne", "adl", "per", "new", "nlm", "gcq"];
		// cancellation token for short synchronous-ish loader
		const myToken = ++presetLoadToken;
		for (const c of cities) {
			// if mode changed/cancelled, stop
			if (myToken !== presetLoadToken) return;
			const url = `https://9now-livestreams-fhd-t.akamaized.net/u/prod/simulcast/${c}/ch9/hls/r1/index.m3u8`;
			const label = cityMap[c] || c;
			// check again before adding (defensive)
			if (myToken !== presetLoadToken) return;
			const entry = { url, instanceId: crypto.randomUUID(), labelText: label };
			streamEntries.push(entry);
			addStreamTile(entry.url, entry.instanceId, label);
		}
		if (myToken === presetLoadToken) layoutGrid();
		return;
	}

	if (mode === "9now") {
		// try up to 100 inputs like the example; add until first failure
		(async () => {
			const myToken = ++presetLoadToken;
			for (let i = 1; i <= 100; i++) {
				// if mode changed/cancelled, stop
				if (myToken !== presetLoadToken) return;
				const index = i.toString().padStart(2, "0");
				const url = `https://9now-livestreams-v2.akamaized.net/prod/event/tbs/9now/input${index}/r1/index.m3u8`;
				// quick HEAD check to avoid spamming invalid entries
				try {
					const ok = await preflightManifest(url, 3000);
					if (!ok || !ok.ok) break;
				} catch {
					break;
				}
				// stop if mode changed while we awaited
				if (myToken !== presetLoadToken) return;
				const entry = { url, instanceId: crypto.randomUUID() };
				streamEntries.push(entry);
				addStreamTile(entry.url, entry.instanceId);
			}
			if (myToken === presetLoadToken) layoutGrid();
		})();
	}
}

function updateEmptyState() {
	const hasTile = [...grid.children].some((el) =>
		el.classList.contains("tile")
	);
	const existing = grid.querySelector(".empty");
	if (!hasTile) {
		if (!existing) {
			const div = document.createElement("div");
			div.className = "empty";
			div.textContent = "No streams yet.";
			grid.appendChild(div);
		}
	} else {
		if (existing) existing.remove();
	}
}

// Preferences were intentionally removed: only stream list persists

function addStreamTile(url, passedInstanceId, labelText) {
	const placeholder = grid.querySelector(".empty");
	if (placeholder) placeholder.remove();

	const tile = document.createElement("div");
	tile.className = "tile";
	tile.tabIndex = 0;
	const isCustomMode = feedSelector && feedSelector.value === "custom";
	tile.setAttribute("draggable", isCustomMode ? "true" : "false");
	tile.dataset.instanceId = passedInstanceId || "";

	// Drag-and-drop reordering logic (Custom mode only)
	if (isCustomMode) {
		tile.addEventListener("dragstart", (e) => {
			tile.classList.add("dragging");
			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData("text/plain", tile.dataset.instanceId);
			}
		});
		tile.addEventListener("dragend", () => {
			tile.classList.remove("dragging");
			grid
				.querySelectorAll(".tile.drop-target")
				.forEach((t) => t.classList.remove("drop-target"));
		});
		tile.addEventListener("dragover", (e) => {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
			tile.classList.add("drop-target");
		});
		tile.addEventListener("dragleave", () => {
			tile.classList.remove("drop-target");
		});
		tile.addEventListener("drop", (e) => {
			e.preventDefault();
			tile.classList.remove("drop-target");
			const fromId = e.dataTransfer ? e.dataTransfer.getData("text/plain") : "";
			const toId = tile.dataset.instanceId;
			if (!fromId || !toId || fromId === toId) return;
			reorderTiles(fromId, toId);
		});
	}
	// Reorder streamEntries and re-render grid
	function reorderTiles(fromId, toId) {
		// Only reorder in Custom mode
		if (!(feedSelector && feedSelector.value === "custom")) return;
		const fromIdx = streamEntries.findIndex((e) => e.instanceId === fromId);
		const toIdx = streamEntries.findIndex((e) => e.instanceId === toId);
		if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
		const moved = streamEntries.splice(fromIdx, 1)[0];
		// insert before the target index (matching DOM insertBefore behavior)
		streamEntries.splice(toIdx, 0, moved);
		saveList();
		// Reorder DOM nodes without destroying players
		try {
			const tiles = Array.from(grid.querySelectorAll(".tile"));
			const fromTile = tiles.find(
				(t) => t.dataset && t.dataset.instanceId === fromId
			);
			const toTile = tiles.find(
				(t) => t.dataset && t.dataset.instanceId === toId
			);
			if (fromTile && toTile && fromTile !== toTile) {
				grid.insertBefore(fromTile, toTile);
			}
		} catch {}
		layoutGrid();
	}
	const video = document.createElement("video");
	video.setAttribute("playsinline", "");
	video.setAttribute("muted", "");
	try {
		video.muted = !!(settings && settings.autoplayMuted);
	} catch {
		video.muted = true;
	}
	video.autoplay = true;
	video.controls = false;
	video.preload = "auto";
	// Ensure native text tracks are off by default when they become available
	video.addEventListener(
		"loadedmetadata",
		() => {
			try {
				const tt = video.textTracks || [];
				for (let i = 0; i < tt.length; i++) tt[i].mode = "disabled";
			} catch {}
		},
		{ once: true }
	);
	// Fallback attempt (some tracks appear after a short delay)
	setTimeout(() => {
		try {
			const tt = video.textTracks || [];
			for (let i = 0; i < tt.length; i++) tt[i].mode = "disabled";
		} catch {}
	}, 600);

	const actions = document.createElement("div");
	actions.className = "hover-actions";
	// place debug icon first (left of other hover actions)
	actions.innerHTML = `
				<div class="icon-btn" title="Toggle debug info" data-action="debug" aria-pressed="false"><i class="ri-bug-line"></i></div>
				<div class="icon-btn" title="Open stream URL in a new tab" data-action="open"><i class="ri-external-link-line"></i></div>
				<div class="icon-btn" title="Remove stream" data-action="close"><i class="ri-close-line"></i></div>
			`;

	const bottom = document.createElement("div");
	bottom.className = "bottom-actions";
	// left-most: live button that contains a small dot and latency badge (integrated), then refresh, mute, cc, quality
	bottom.innerHTML = `
				<div class="icon-btn" title="Go to live" data-action="live">
					<span class="live-dot" aria-hidden="true"></span>
					<div class="latency-badge">&nbsp;</div>
				</div>
                <div class="icon-btn" title="Refresh stream" data-action="refresh"><i class="ri-refresh-line"></i></div>
                <div class="icon-btn" title="Unmute" data-action="mute"><i class="ri-volume-mute-line"></i></div>
                <div class="icon-btn" title="Subtitles" data-action="cc"><i class="ri-closed-captioning-line"></i><span class="cc-badge" style="display:none"></span></div>
                <div class="icon-btn" title="Quality/Resolution" data-action="cog"><i class="ri-settings-3-line"></i></div>
            `;

	tile.appendChild(video);
	tile.appendChild(actions);
	tile.appendChild(bottom);
	grid.appendChild(tile);

	// Add a spinner overlay element (hidden by default)
	const spinnerOverlay = document.createElement("div");
	spinnerOverlay.className = "spinner-overlay";
	const spinner = document.createElement("div");
	spinner.className = "spinner";
	spinnerOverlay.appendChild(spinner);
	tile.appendChild(spinnerOverlay);

	// Debug panel (hidden by default) — toggled by the bug icon
	const debugPanel = document.createElement("div");
	debugPanel.className = "debug-panel";
	debugPanel.style.position = "absolute";
	debugPanel.style.left = "6px";
	debugPanel.style.top = "6px";
	debugPanel.style.zIndex = 60;
	debugPanel.style.background = "rgba(0,0,0,0.6)";
	debugPanel.style.color = "#e7edf5";
	// tighter padding and allow a wider panel to avoid internal scrollbars
	debugPanel.style.padding = "4px 6px";
	// let CSS handle font-size/family so it matches the page (we added .debug-panel in CSS)
	debugPanel.style.maxWidth = "72%";
	debugPanel.style.maxHeight = "72%";
	debugPanel.style.overflow = "auto";
	debugPanel.style.display = "none";
	debugPanel.style.border = "1px solid rgba(255,255,255,0.06)";
	tile.appendChild(debugPanel);

	// Optional top-left label (used for ch9 city names)
	if (labelText) {
		const topLabel = document.createElement("div");
		topLabel.className = "top-left-label";
		topLabel.textContent = labelText;
		tile.appendChild(topLabel);
	}

	// apply settings defaults (muted/autoplay and debug visibility)
	try {
		if (settings && typeof settings.autoplayMuted !== "undefined") {
			video.muted = !!settings.autoplayMuted;
			// keep rec.muted consistent; will be set later below
		}
		if (settings && settings.showDebugByDefault)
			debugPanel.style.display = "block";
	} catch {}

	tile.addEventListener("dblclick", (e) => {
		// Ignore double-clicks that happen on UI elements (controls/menus)
		try {
			if (
				e &&
				e.target &&
				(e.target.closest(".icon-btn") ||
					e.target.closest(".menu") ||
					e.target.closest(".cc-menu") ||
					e.target.closest(".quality-menu"))
			)
				return;
		} catch {}
		if (!document.fullscreenElement) tile.requestFullscreen?.();
		else document.exitFullscreen?.();
	});

	actions.addEventListener("click", (e) => {
		const btn = e.target.closest(".icon-btn");
		if (!btn) return;
		const action = btn.getAttribute("data-action");
		if (action === "debug") {
			try {
				toggleDebugForTile(tile, btn);
			} catch {}
			return;
		}
		if (action === "open") {
			try {
				const rec = getRecByTile(tile);
				const href = rec && rec.url ? rec.url : url;
				window.open(href, "_blank", "noopener");
			} catch {
				window.open(url, "_blank", "noopener");
			}
		} else if (action === "close") {
			const rec = getRecByTile(tile);
			destroyTile(tile, (rec && rec.url) || url);
			saveList();
			layoutGrid();
		}
	});

	// Helper: remove any open menus under this tile so only one option panel is visible
	const closeMenusOnTile = () => {
		try {
			const menus = tile.querySelectorAll(".menu, .cc-menu, .quality-menu");
			menus.forEach((m) => m.remove());
		} catch {}
	};

	// Helper to toggle debug panel for this tile
	const toggleDebugForTile = (tileEl, btn) => {
		try {
			const rec = getRecByTile(tileEl);
			const panel =
				rec && rec.tile ? rec.tile.querySelector(".debug-panel") : null;
			if (!panel) return;
			const pressed =
				btn && btn.getAttribute && btn.getAttribute("aria-pressed") === "true";
			if (btn && btn.setAttribute)
				btn.setAttribute("aria-pressed", String(!pressed));
			panel.style.display = pressed ? "none" : "block";
			// prime content immediately when showing
			if (!pressed && rec && typeof rec._debugUpdate === "function") {
				try {
					rec._debugUpdate();
				} catch {}
			}
		} catch {}
	};

	// Helper to show the proper menu for hover or click (closes others first)
	const showMenuForAction = (btn) => {
		const action = btn.getAttribute("data-action");
		const rec = getRecByTile(tile);
		if (!rec) return;
		try {
			// close existing menus on this tile before opening a new one
			closeMenusOnTile();
			if (action === "mute") {
				try {
					showVolumeMenu(rec, btn);
				} catch {}
			} else if (action === "cc") {
				try {
					toggleSubtitles(rec, btn);
				} catch {}
			} else if (action === "cog") {
				try {
					showQualityMenu(rec, btn);
				} catch {}
			}
		} catch {}
	};

	// Attach pointerenter to bottom icons that show menus so they appear on hover
	bottom.querySelectorAll(".icon-btn").forEach((btn) => {
		const action = btn.getAttribute("data-action");
		if (action === "mute" || action === "cc" || action === "cog") {
			btn.addEventListener("pointerenter", (e) => {
				showMenuForAction(btn);
			});
		}
	});

	// Ensure menus are removed when the tile's UI hides (tile mouseleave)
	tile.addEventListener("pointerleave", (e) => {
		try {
			const existing = tile.querySelector(".menu");
			if (existing) existing.remove();
		} catch {}
	});

	bottom.addEventListener("click", (e) => {
		const btn = e.target.closest(".icon-btn");
		if (!btn) return;
		const action = btn.getAttribute("data-action");
		const rec = getRecByTile(tile);

		// debug toggle
		if (action === "debug") {
			try {
				toggleDebugForTile(tile, btn);
			} catch {}
			return;
		}
		if (action === "refresh") {
			if (rec) hardRefresh(rec);
		} else if (action === "live") {
			try {
				if (rec) gotoLive(rec);
			} catch {}
		} else if (action === "mute") {
			try {
				// toggle internal muted state first
				rec.muted = !rec.muted;
				// reflect onto the media element
				try {
					rec.video.muted = rec.muted;
				} catch {}
				// update button UI consistently
				try {
					updateMuteButtonUI(rec);
				} catch {}
				// if unmuted, attempt to resume playback (user gesture) so streams don't remain frozen
				try {
					if (!rec.muted) {
						try {
							rec.video.play().catch(() => {});
						} catch {}
					}
				} catch {}
			} catch {}
			// Preferences removed: do not persist muted/volume
			// unmute overlay removed; no-op
			// open volume menu for fine control (close others first)
			try {
				closeMenusOnTile();
				showVolumeMenu(rec, btn);
			} catch {}
		} else if (action === "cc") {
			toggleSubtitles(rec, btn);
		} else if (action === "cog") {
			showQualityMenu(rec, btn);
		}
	});

	// instance id (use passed one when restoring from saved list)
	const instanceId = passedInstanceId || crypto.randomUUID();
	const id = instanceId;
	// streams start muted by default
	const initialVolume = video.volume || 1;
	const rec = {
		instanceId,
		hls: null,
		video,
		url,
		tile,
		backoffMs: 0,
		lastTime: 0,
		healthTimer: null,
		needsHeal: false,
		subtitleChoice: "Off",
		volume: initialVolume,
		muted: !!(settings && settings.autoplayMuted),
		preferredQuality: null,
	};

	// If user prefers subtitles by default, mark this tile to auto-enable subtitles
	// We will select the first available subtitle track (HLS subtitleTracks first,
	// then native textTracks) when tracks become available.
	try {
		if (settings && settings.showSubtitlesByDefault) {
			if (!rec.subtitleChoice || rec.subtitleChoice === "Off") {
				// leave subtitleChoice unset and mark as auto-enabled
				rec.subtitleChoice = null;
				rec._autoSubtitle = true;
			}
		}
	} catch {}

	// Debugging: populate debug panel and track hls events + small network samples
	rec._debugEvents = [];
	rec._netActivity = [];
	rec._debugUpdate = () => {
		try {
			const panel = rec.tile.querySelector(".debug-panel");
			if (!panel) return;
			const v = rec.video || {};

			// stream URL (full)
			const shortUrl = rec.url || "";

			// frames processed / dropped
			let framesInfo = "N/A";
			try {
				if (typeof v.getVideoPlaybackQuality === "function") {
					const q = v.getVideoPlaybackQuality();
					framesInfo = `${q.totalVideoFrames || 0} processed / ${
						q.droppedVideoFrames || 0
					} dropped`;
				} else if (typeof v.webkitDecodedFrameCount !== "undefined") {
					framesInfo = `${
						v.webkitDecodedFrameCount || 0
					} processed / 0 dropped`;
				}
			} catch {}

			const vw = v.videoWidth || 0,
				vh = v.videoHeight || 0;

			let optimal = "?";
			try {
				if (rec.hls && rec.hls.levels && rec.hls.levels.length) {
					const top = rec.hls.levels[rec.hls.levels.length - 1];
					if (top)
						optimal = `${top.width || "?"}x${top.height || "?"}@${
							top.bitrate ? Math.round(top.bitrate / 1000) : "?"
						}kbps`;
				}
			} catch {}

			// volume removed from debug panel

			// codec: show the actual codec string if available
			let videoCodec = "unknown",
				audioCodec = "unknown",
				audioLang = "unknown",
				audioBitrate = "N/A",
				audioChannels = "unknown";
			try {
				if (rec.hls && rec.hls.levels && rec.hls.levels.length) {
					const cur =
						rec.hls.levels[
							rec.hls.currentLevel >= 0
								? rec.hls.currentLevel
								: rec.hls.levels.length - 1
						] || rec.hls.levels[0];
					let codecsAttr =
						cur && cur.attrs && cur.attrs.CODECS
							? cur.attrs.CODECS
							: cur && cur.codec
							? cur.codec
							: "";
					if (codecsAttr) {
						const parts = codecsAttr
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean);
						if (parts.length >= 1) videoCodec = parts[0];
						if (parts.length >= 2) audioCodec = parts[1];
					}
					// try to infer audio language/bitrate/channels from audioTracks if available
					if (
						rec.hls &&
						Array.isArray(rec.hls.audioTracks) &&
						typeof rec.hls.audioTrack === "number"
					) {
						const at = rec.hls.audioTracks[rec.hls.audioTrack];
						if (at) {
							audioLang = at.lang || at.name || audioLang;
							// try several possible fields for bitrate/bandwidth and ignore non-positive values
							let ab = null;
							if (typeof at.bitrate === "number" && at.bitrate > 0)
								ab = at.bitrate;
							else if (typeof at.bandwidth === "number" && at.bandwidth > 0)
								ab = at.bandwidth;
							else if (at.attrs) {
								const keys = Object.keys(at.attrs || {});
								const findKey = (names) =>
									keys.find((k) => names.includes(k.toUpperCase()));
								const bkey = findKey(["BANDWIDTH", "bandwidth"]);
								if (bkey) {
									const parsed = parseInt(at.attrs[bkey], 10);
									if (!isNaN(parsed) && parsed > 0) ab = parsed;
								}
								const ckey = findKey(["CHANNELS", "channels"]);
								if (ckey) {
									const parsed = parseInt(at.attrs[ckey], 10);
									if (!isNaN(parsed) && parsed > 0)
										audioChannels = parsed.toString();
								}
								const lkey = findKey(["LANGUAGE", "LANG", "language", "lang"]);
								if (lkey) audioLang = at.attrs[lkey] || audioLang;
							}
							// also check explicit channel fields on the audioTrack
							if (typeof at.channels === "number" && at.channels > 0)
								audioChannels = String(at.channels);
							if (typeof at.channelCount === "number" && at.channelCount > 0)
								audioChannels = String(at.channelCount);
							if (ab && ab > 0) audioBitrate = Math.round(ab / 1000) + " kbps";
						}
					}
					// fallback: if audio codec still unknown, scan levels for a second codec in CODECS
					if (
						(audioCodec === "unknown" || !audioCodec) &&
						Array.isArray(rec.hls.levels)
					) {
						for (const L of rec.hls.levels) {
							try {
								const ca =
									(L && L.attrs && L.attrs.CODECS) || (L && L.codec) || "";
								if (!ca) continue;
								const parts = ca
									.split(",")
									.map((s) => s.trim())
									.filter(Boolean);
								if (parts.length >= 2) {
									audioCodec = parts[1];
									break;
								}
							} catch {}
						}
					}
				}
			} catch {}

			// connection speed plain text only
			let kbps = "N/A";
			try {
				if (
					rec.hls &&
					typeof rec.hls.bandwidthEstimate === "number" &&
					rec.hls.bandwidthEstimate > 0
				)
					kbps = Math.round(rec.hls.bandwidthEstimate / 1000) + " Kbps";
				else if (rec._netActivity && rec._netActivity.length) {
					const last = rec._netActivity[rec._netActivity.length - 1];
					if (last && last.bytes && last.dt)
						kbps = Math.round(last.bytes / (last.dt / 1000) / 1000) + " Kbps";
				}
			} catch {}

			// current stream bitrate (from the current hls level when available)
			let curBitrate = "N/A";
			try {
				if (
					rec.hls &&
					rec.hls.levels &&
					rec.hls.levels.length &&
					typeof rec.hls.currentLevel === "number" &&
					rec.hls.currentLevel >= 0
				) {
					const lvl = rec.hls.levels[rec.hls.currentLevel] || rec.hls.levels[0];
					if (lvl && typeof lvl.bitrate === "number" && lvl.bitrate > 0)
						curBitrate = Math.round(lvl.bitrate / 1000) + " kbps";
				} else if (rec.hls && rec.hls.levels && rec.hls.levels.length) {
					// fallback: show the first level bitrate
					const lvl = rec.hls.levels[0];
					if (lvl && typeof lvl.bitrate === "number" && lvl.bitrate > 0)
						curBitrate = Math.round(lvl.bitrate / 1000) + " kbps";
				}
			} catch {}

			// build current and max resolution+bitrate strings
			let currentResStr = `${vw}x${vh}`;
			try {
				if (curBitrate && curBitrate !== "N/A")
					currentResStr += " @ " + curBitrate;
			} catch {}

			let maxResStr = "?";
			try {
				if (rec.hls && rec.hls.levels && rec.hls.levels.length) {
					const top = rec.hls.levels[rec.hls.levels.length - 1];
					if (top) {
						const tb =
							typeof top.bitrate === "number" && top.bitrate > 0
								? Math.round(top.bitrate / 1000) + " kbps"
								: null;
						maxResStr = `${top.width || "?"}x${top.height || "?"}${
							tb ? " @ " + tb : ""
						}`;
					}
				}
			} catch {}

			let bufferHealth = "N/A";
			try {
				if (v && v.buffered && v.buffered.length) {
					const end = v.buffered.end(v.buffered.length - 1);
					bufferHealth = (end - (v.currentTime || 0)).toFixed(2) + " s";
				}
			} catch {}

			let liveLatency = "N/A";
			try {
				if (rec.hls && typeof rec.hls.liveSyncPosition === "number") {
					const pos = rec.hls.liveSyncPosition || 0;
					liveLatency = (pos - (v.currentTime || 0)).toFixed(2) + " s";
				}
			} catch {}

			// playback speed
			let playbackRate = "1.00x";
			try {
				const pr =
					typeof v.playbackRate === "number"
						? v.playbackRate
						: v.playbackRate
						? Number(v.playbackRate)
						: 1;
				if (!isNaN(pr)) playbackRate = pr.toFixed(2) + "x";
			} catch {}

			// only show low-latency mode when relevant; omitted otherwise

			// slimline network activity sparkline
			let activityHtml = "";
			try {
				const samples = (rec._netActivity || []).slice(-16);
				const max = Math.max(1, ...samples.map((s) => s.bytes || 0));
				activityHtml = samples
					.map((s) => {
						const h = Math.round(((s.bytes || 0) / max) * 12) + 2;
						const color = s.bytes && s.bytes > 0 ? "#7fe3a7" : "#333";
						return `<span style="display:inline-block;width:4px;height:${h}px;margin-right:1px;background:${color};vertical-align:bottom;border-radius:1px"></span>`;
					})
					.join("");
			} catch {}

			// estimate audio bitrate from recent audio-ish fragments when audioBitrate is not available
			let estimatedAudio = null;
			try {
				if (
					(audioBitrate === "N/A" || audioBitrate === "0 kbps") &&
					Array.isArray(rec._netActivity) &&
					rec._netActivity.length
				) {
					const samples = rec._netActivity.slice().reverse();
					let collectedBytes = 0,
						collectedMs = 0,
						count = 0;
					for (const s of samples) {
						if (count >= 12) break;
						const isAudio =
							s.type && String(s.type).toLowerCase().includes("audio");
						const small = (s.bytes || 0) < 80 * 1024;
						if (isAudio || small) {
							collectedBytes += s.bytes || 0;
							collectedMs += s.dt || 1000;
							count++;
						}
					}
					if (collectedMs > 0 && collectedBytes > 0) {
						const bps = (collectedBytes * 8) / (collectedMs / 1000);
						estimatedAudio = Math.round(bps / 1000) + " kbps";
					}
				}
			} catch (e) {}

			const html = `
				<div style="font-weight:700;margin-bottom:6px">Stream URL &nbsp; <span style='font-weight:400'>${shortUrl}</span></div>
				<div style="display:flex;gap:12px;margin-bottom:4px"><div style='min-width:180px'>Frames</div><div style='flex:1'>${framesInfo}</div></div>
				<div style="display:flex;gap:12px;margin-bottom:4px"><div style='min-width:180px'>Current / Max</div><div style='flex:1'>${currentResStr} / ${maxResStr}</div></div>
				<!-- volume removed -->
				<div style="display:flex;gap:12px;margin-bottom:4px"><div style='min-width:180px'>Video Codec / Bitrate</div><div style='flex:1'>${videoCodec} ${
				curBitrate !== "N/A" ? "@ " + curBitrate : ""
			}</div></div>
				<div style="display:flex;gap:12px;margin-bottom:4px"><div style='min-width:180px'>Audio Codec / Lang / Ch</div><div style='flex:1'>${audioCodec} ${
				audioLang && audioLang !== "unknown" ? "(" + audioLang + ")" : ""
			} ${
				audioChannels && audioChannels !== "unknown"
					? "[" + audioChannels + "ch]"
					: ""
			}</div></div>
				<div style="display:flex;gap:12px;margin-bottom:4px"><div style='min-width:180px'>Playback Speed</div><div style='flex:1'>${playbackRate}</div></div>
				<div style="display:flex;gap:12px;margin-bottom:4px"><div style='min-width:180px'>Current Bitrate</div><div style='flex:1'>${curBitrate}</div></div>
				<div style="display:flex;gap:12px;margin-bottom:4px"><div style='min-width:180px'>Connection Speed</div><div style='flex:1'>${kbps}</div></div>
				<div style="display:flex;gap:12px;margin-bottom:4px"><div style='min-width:180px'>Network Activity</div><div style='flex:1'>${activityHtml}</div></div>
				<div style="display:flex;gap:12px;margin-bottom:4px"><div style='min-width:180px'>Buffer Health</div><div style='flex:1'>${bufferHealth}</div></div>
				<div style="display:flex;gap:12px;margin-bottom:4px"><div style='min-width:180px'>Live Latency</div><div style='flex:1'>${liveLatency}</div></div>
			`;

			panel.innerHTML = html;
		} catch {}
	};

	// keep a short interval for live stats
	rec._debugTimer = setInterval(() => {
		try {
			rec._debugUpdate();
		} catch {}
	}, 800);
	players.set(id, rec);
	// prime the debug panel content immediately
	try {
		rec._debugUpdate();
	} catch {}
	// apply volume/muted immediately so playback respects preference (muted by default)
	try {
		video.volume = rec.volume;
		video.muted = !!rec.muted;
		updateMuteButtonUI(rec);
	} catch {}

	// spinner helpers
	rec._showSpinner = () => {
		try {
			const el = rec.tile.querySelector(".spinner-overlay");
			if (el) el.classList.add("visible");
		} catch {}
	};
	rec._hideSpinner = () => {
		try {
			const el = rec.tile.querySelector(".spinner-overlay");
			if (el) el.classList.remove("visible");
		} catch {}
	};

	// Video-level events for buffering/playing state
	const onWaiting = () => {
		rec._showSpinner();
	};
	const onStalled = () => {
		rec._showSpinner();
	};
	const onPlaying = () => {
		rec._hideSpinner();
	};
	const onCanPlay = () => {
		rec._hideSpinner();
	};
	const onCanPlayThrough = () => {
		rec._hideSpinner();
	};
	const onError = () => {
		rec._hideSpinner();
	};
	video.addEventListener("waiting", onWaiting);
	video.addEventListener("stalled", onStalled);
	video.addEventListener("playing", onPlaying);
	video.addEventListener("canplay", onCanPlay);
	video.addEventListener("canplaythrough", onCanPlayThrough);
	video.addEventListener("error", onError);
	// Latency / live badge update timer (created per-rec)
	rec._updateLatencyUI = () => updateLatencyUI(rec);
	rec._latencyTimer = setInterval(() => {
		try {
			updateLatencyUI(rec);
		} catch {}
	}, 800);

	setupPlayer(rec);
	startHealthCheck(rec);
	layoutGrid();
}

function setupPlayer(rec) {
	// setupPlayer called
	const { video, url } = rec;
	// Preserve current playback position so rebuilds/reconnects don't jump to live
	rec._preservePosition =
		video && typeof video.currentTime === "number" && video.currentTime > 0.5
			? video.currentTime
			: null;
	if (rec._preservePosition && rec._preservePosition <= 0.5) {
		rec._preservePosition = null;
	}
	if (rec.hls) {
		try {
			if (rec.hls) rec.hls.destroy();
		} catch {}
		rec.hls = null;
	}
	video.src = "";
	video.load();

	const ensurePlay = () => {
		try {
			const p = video.play();
			if (p && typeof p.then === "function") {
				p.catch(() => {
					/* ignore autoplay rejection when muted-by-default */
				});
			}
		} catch (e) {
			/* ignore */
		}
	};

	// Build candidate URLs: try the base .m3u8 first (strip anything after .m3u8), then fall back to the full URL
	const deriveBaseM3U8 = (u) => {
		try {
			const s = String(u || "");
			const idx = s.toLowerCase().indexOf(".m3u8");
			if (idx === -1) return s;
			return s.slice(0, idx + ".m3u8".length);
		} catch {
			return u;
		}
	};
	const _baseCandidate = deriveBaseM3U8(url);
	const _firstTry =
		_baseCandidate && _baseCandidate !== url ? _baseCandidate : url;
	const _secondTry = _baseCandidate && _baseCandidate !== url ? url : null;
	// Reset and track the active URL actually used for playback
	rec._activeUrl = null;

	if (window.Hls && Hls.isSupported()) {
		// using hls.js for this url
		// Do a quick preflight to detect 404/CORS/bogus responses before creating Hls
		try {
			if (rec._showSpinner) rec._showSpinner();
		} catch {}
		preflightManifest(_firstTry, 5000)
			.then((pf) => {
				if (!pf || !pf.ok) {
					// show actionable error on tile instead of creating Hls
					showTileError(
						rec,
						pf && pf.reason
							? `Manifest error: ${pf.reason}`
							: `Unable to load manifest (${
									pf && pf.status ? pf.status : "error"
							  })`
					);
					return;
				}
				const hls = new Hls({
					// prevent hls.js from increasing playbackRate to catch up to live
					// setting to 1.0 disables speed-up behavior
					maxLiveSyncPlaybackRate: 1.0,
					enableWorker: true,
					// disable low-latency heuristics that can aggressively speed/seek to live
					lowLatencyMode: false,
					backBufferLength: 30,
					capLevelToPlayerSize: false,
				});
				rec.hls = hls;
				// Persist chosen base URL if it differs and works
				try {
					if (_firstTry && _firstTry !== url) {
						rec._activeUrl = _firstTry;
						// update rec.url and streamEntries
						rec.url = _firstTry;
						const idx = streamEntries.findIndex(
							(e) => e.instanceId === rec.instanceId
						);
						if (idx !== -1) {
							streamEntries[idx].url = _firstTry;
							saveList();
						}
					}
				} catch {}
				// small helper to push debug messages
				const pushDebug = (msg) => {
					try {
						rec._debugEvents = rec._debugEvents || [];
						rec._debugEvents.push({
							ts: new Date().toISOString().substr(11, 8),
							msg,
						});
						// keep it small
						if (rec._debugEvents.length > 200)
							rec._debugEvents.splice(0, rec._debugEvents.length - 200);
					} catch {}
				};
				// wire some informative Hls events
				hls.on(Hls.Events.LEVEL_LOADED, (_, data) =>
					pushDebug(`LEVEL_LOADED level=${data.level}`)
				);
				hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) =>
					pushDebug(`LEVEL_SWITCHED level=${data.level}`)
				);
				hls.on(Hls.Events.FRAG_LOADING, (_, data) =>
					pushDebug(`FRAG_LOADING sn=${data.frag && data.frag.sn}`)
				);
				hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
					try {
						pushDebug(`FRAG_LOADED sn=${data.frag && data.frag.sn}`);
						try {
							const stats =
								data && data.frag && data.frag.stats ? data.frag.stats : null;
							const bytes =
								stats && (stats.total || stats.loaded || stats.bwEstimate)
									? stats.total || stats.loaded || stats.bwEstimate
									: 0;
							const dt =
								stats && stats.tload && stats.trequest
									? Math.max(1, stats.tload - stats.trequest)
									: 1000;
							// try to capture fragment type (audio / main) when available
							const fragType =
								data && data.frag && data.frag.type
									? data.frag.type
									: data && data.frag && data.frag.cc
									? String(data.frag.cc)
									: "";
							rec._netActivity = rec._netActivity || [];
							rec._netActivity.push({
								t: Date.now(),
								bytes: bytes,
								dt: dt,
								type: fragType,
							});
						} catch (e) {}
					} catch (e) {}
				});
				hls.attachMedia(video);
				// continue wiring events below in the same block
				hls.on(Hls.Events.MEDIA_ATTACHED, () => {
					try {
						hls.loadSource(rec._activeUrl || url);
						// If we preserved a playback position, start loading from that position
						if (
							typeof rec._preservePosition === "number" &&
							!Number.isNaN(rec._preservePosition)
						) {
							try {
								// startLoad with a position attempts to load buffer relative to that time
								hls.startLoad(rec._preservePosition);
							} catch (e) {
								// fallback: normal startLoad
								try {
									hls.startLoad();
								} catch (_) {}
							}
						}
					} catch (e) {
						// Ensure source is loaded even if startLoad fails
						try {
							hls.loadSource(rec._activeUrl || url);
						} catch (_) {}
					}
				});
				hls.on(Hls.Events.MANIFEST_PARSED, () => {
					// manifest parsed
					try {
						if (rec._hideSpinner) rec._hideSpinner();
					} catch {}
					rec.errorAttempts = 0; // reset error counter on success
					if (hls.levels && hls.levels.length > 0) {
						const top = hls.levels.length - 1;
						hls.nextLevel = top;
						hls.currentLevel = top;
						hls.loadLevel = top;
						// populate rec.levels for the quality menu (robust bitrate parsing)
						rec.levels = (hls.levels || []).map((l, i) => {
							const attrs = l.attrs || {};
							const bitrate =
								l.bitrate ||
								l.maxBitrate ||
								(attrs.BANDWIDTH ? parseInt(attrs.BANDWIDTH, 10) : 0) ||
								0;
							return { id: i, width: l.width, height: l.height, bitrate };
						});
						// apply any persisted preferred quality (including -1 for Auto)
						try {
							if (
								typeof rec.preferredQuality !== "undefined" &&
								rec.preferredQuality !== null
							) {
								if (rec.preferredQuality === -1) {
									hls.currentLevel = -1;
								} else if (
									Number.isInteger(rec.preferredQuality) &&
									rec.preferredQuality >= 0 &&
									rec.preferredQuality < hls.levels.length
								) {
									hls.currentLevel = rec.preferredQuality;
								}
							}
						} catch (e) {
							/* ignore */
						}
						// default subtitles off for hls.js-managed subtitle tracks if they exist
						try {
							if (hls.subtitleTracks && hls.subtitleTracks.length) {
								hls.subtitleTrack = -1;
							}
						} catch {}
					}
					// If a preserved playback position exists, restore it so the element stays behind live
					try {
						if (
							typeof rec._preservePosition === "number" &&
							!Number.isNaN(rec._preservePosition)
						) {
							try {
								rec.video.currentTime = rec._preservePosition;
							} catch (_) {}
						}
					} catch (_) {}
					resetBackoff(rec);
					ensurePlay();
					// clear preserved position after use
					try {
						rec._preservePosition = null;
					} catch (_) {}
					// apply persisted/default subtitle choice
					try {
						applySubtitleChoice(rec);
					} catch {}
				});
				// Listen for subtitle track updates and switches
				hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_, data) => {
					try {
						rec.subtitleTracks =
							data.subtitleTracks || hls.subtitleTracks || [];
						// If the user opted to show subtitles by default and this tile was
						// initialized with the 'Auto' sentinel, attempt to apply a selection
						// now that subtitle track metadata is available.
						try {
							// If this tile was auto-marked for subtitles (rec._autoSubtitle)
							// or has a language-coded subtitleChoice (lang:xx), try to apply
							if (settings && settings.showSubtitlesByDefault) {
								const isAuto = !!rec._autoSubtitle;
								const isLangChoice =
									typeof rec.subtitleChoice === "string" &&
									rec.subtitleChoice.startsWith("lang:");
								if (isAuto || isLangChoice) {
									applySubtitleChoice(rec);
									updateCcBadge(rec);
								}
							}
						} catch (e) {}
					} catch (e) {
						console.error("subtitle tracks updated error", e);
					}
				});
				hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (_, data) => {
					try {
						if (typeof data.id !== "undefined") {
							if (data.id === -1) rec.subtitleChoice = "Off";
							else rec.subtitleChoice = `hls:${data.id}`;
						}
						updateCcBadge(rec);
					} catch (e) {
						console.error("subtitle track switch error", e);
					}
				});
				// expose levels for quality menu
				hls.on(Hls.Events.LEVELS_UPDATED, () => {
					try {
						rec.levels = (hls.levels || []).map((l, i) => {
							const attrs = l.attrs || {};
							const bitrate =
								l.bitrate ||
								l.maxBitrate ||
								(attrs.BANDWIDTH ? parseInt(attrs.BANDWIDTH, 10) : 0) ||
								0;
							return { id: i, width: l.width, height: l.height, bitrate };
						});
						// re-apply preferred quality if set and levels changed
						try {
							if (
								typeof rec.preferredQuality !== "undefined" &&
								rec.preferredQuality !== null
							) {
								if (rec.preferredQuality === -1) {
									hls.currentLevel = -1;
								} else if (
									Number.isInteger(rec.preferredQuality) &&
									rec.preferredQuality >= 0 &&
									rec.preferredQuality < hls.levels.length
								) {
									hls.currentLevel = rec.preferredQuality;
								}
							}
						} catch (e) {}
					} catch (e) {
						/* ignore */
					}
				});
				hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
					rec.currentLevel = data.level;
				});
				hls.on(Hls.Events.LEVEL_LOADED, () => {
					if (hls.levels && hls.levels.length > 0) {
						const top = hls.levels.length - 1;
						if (hls.currentLevel !== top) hls.currentLevel = top;
					}
				});
				hls.on(Hls.Events.ERROR, (_, data) => {
					handleHlsError(rec, data);
				});
			})
			.catch((e) => {
				// If first preflight failed and we have a second candidate, try it
				if (_secondTry) {
					preflightManifest(_secondTry, 5000)
						.then((pf2) => {
							if (pf2 && pf2.ok) {
								// Since secondTry is the original full URL, keep rec.url as-is
								rec._activeUrl = _secondTry;
								// Re-run setup to attach using the second URL
								try {
									setupPlayer(rec);
								} catch {}
								return;
							}
							showTileError(rec, "Manifest preflight failed");
						})
						.catch(() => showTileError(rec, "Manifest preflight failed"));
				} else {
					showTileError(rec, "Manifest preflight failed");
				}
			});
	} else if (video.canPlayType("application/vnd.apple.mpegurl")) {
		// For native playback, choose candidate similarly
		const nativeTry = (_active) => {
			video.src = _active;
		};
		preflightManifest(_firstTry, 5000)
			.then((pf) => {
				if (pf && pf.ok) {
					rec._activeUrl = _firstTry;
					// Persist trimmed URL when base candidate works
					if (_firstTry !== url) {
						try {
							rec.url = _firstTry;
							const idx = streamEntries.findIndex(
								(e) => e.instanceId === rec.instanceId
							);
							if (idx !== -1) {
								streamEntries[idx].url = _firstTry;
								saveList();
							}
						} catch {}
					}
					nativeTry(_firstTry);
					return;
				}
				if (_secondTry) {
					return preflightManifest(_secondTry, 5000).then((pf2) => {
						if (pf2 && pf2.ok) {
							rec._activeUrl = _secondTry;
							nativeTry(_secondTry);
						} else {
							showTileError(rec, "Manifest preflight failed");
						}
					});
				} else {
					showTileError(rec, "Manifest preflight failed");
				}
			})
			.catch(() => showTileError(rec, "Manifest preflight failed"));
		video.addEventListener(
			"loadedmetadata",
			() => {
				try {
					if (rec._hideSpinner) rec._hideSpinner();
				} catch {}
				rec.errorAttempts = 0;
				resetBackoff(rec);
				ensurePlay();
				try {
					applySubtitleChoice(rec);
				} catch {}
				// restore preserved position for native playback so we don't jump to live
				try {
					if (
						typeof rec._preservePosition === "number" &&
						!Number.isNaN(rec._preservePosition)
					) {
						try {
							video.currentTime = rec._preservePosition;
						} catch (_) {}
						try {
							rec._preservePosition = null;
						} catch (_) {}
					}
				} catch (_) {}
			},
			{ once: true }
		);
		// For native playback, reset error attempts on successful metadata load (handled above)
		// for native playback, attempt to populate textTracks from existing tracks on the element
		setTimeout(() => {
			try {
				rec.textTracks = Array.from(video.textTracks || []);
			} catch {
				rec.textTracks = [];
			}
		}, 500);
	} else {
		showUnsupported(rec.tile);
	}
}

// Toggle subtitles: create a track list UI, persist selection, and attach/detach cues
function toggleSubtitles(rec, btn) {
	if (!rec) return;
	// If menu exists, remove it
	const existing = rec.tile.querySelector(".cc-menu");
	if (existing) {
		existing.remove();
		return;
	}
	const menu = document.createElement("div");
	menu.className = "menu cc-menu";
	const ul = document.createElement("ul");
	// gather tracks: explicitly tag HLS vs native tracks so selections are unambiguous
	const tracks = [];
	try {
		if (rec.hls && rec.hls.subtitleTracks && rec.hls.subtitleTracks.length) {
			rec.hls.subtitleTracks.forEach((t, i) =>
				tracks.push({
					type: "hls",
					id: i,
					label: t.name || t.lang || `sub-${i}`,
				})
			);
		}
	} catch {}
	try {
		(rec.video.textTracks || []).forEach((t, i) =>
			tracks.push({
				type: "native",
				id: i,
				label: t.label || t.language || `track-${i}`,
			})
		);
	} catch {}

	// Build track list; 'Off' will be appended last so it remains at the bottom
	const offLi = document.createElement("li");
	const offChk = document.createElement("span");
	offChk.className = "check";
	offChk.textContent = "✔";
	const offTxt = document.createElement("span");
	offTxt.textContent = "Off";
	offLi.appendChild(offChk);
	offLi.appendChild(offTxt);
	offLi.tabIndex = 0;
	offLi.addEventListener("click", () => {
		rec.subtitleChoice = "Off";
		applySubtitleChoice(rec);
		updateCcBadge(rec);
		menu.remove();
	});

	// normalize current choice similar to applySubtitleChoice so we can mark the active item
	let currentChoice = rec.subtitleChoice;
	try {
		if (currentChoice && typeof currentChoice !== "string")
			currentChoice = String(currentChoice);
		if (currentChoice && /^[0-9]+$/.test(currentChoice))
			currentChoice = `hls:${currentChoice}`;
		if (currentChoice && /^t\d+$/.test(currentChoice))
			currentChoice = `native:${currentChoice.slice(1)}`;
	} catch (e) {
		/* ignore */
	}

	const addItem = (label, cb, isActive) => {
		const li = document.createElement("li");
		const chk = document.createElement("span");
		chk.className = "check";
		chk.textContent = "✔";
		const txt = document.createElement("span");
		txt.textContent = label;
		li.appendChild(chk);
		li.appendChild(txt);
		if (isActive) li.classList.add("active");
		li.tabIndex = 0;
		li.addEventListener("click", () => {
			cb();
			menu.remove();
		});
		ul.appendChild(li);
	};

	if (tracks.length === 0) {
		const li = document.createElement("li");
		li.textContent = "No subtitles available";
		ul.appendChild(li);
		// mark Off active if that's the current choice
		if (!currentChoice || currentChoice === "Off")
			offLi.classList.add("active");
		ul.appendChild(offLi);
	} else {
		tracks.forEach((t) => {
			const key = `${t.type}:${t.id}`;
			addItem(
				t.label,
				() => {
					rec.subtitleChoice = key;
					applySubtitleChoice(rec);
					updateCcBadge(rec);
				},
				currentChoice === key
			);
		});
		// append Off as the last option and mark active if selected
		if (!currentChoice || currentChoice === "Off")
			offLi.classList.add("active");
		ul.appendChild(offLi);
	}
	menu.appendChild(ul);
	// append hidden to measure size, then position above the button if possible
	menu.style.visibility = "hidden";
	rec.tile.appendChild(menu);
	positionMenuNearButton(menu, btn, rec.tile);
	menu.style.visibility = "";
	// remove menu when clicking outside
	const off = (ev) => {
		if (!menu.contains(ev.target)) {
			menu.remove();
			document.removeEventListener("click", off);
		}
	};
	setTimeout(() => document.addEventListener("click", off));
}

// Show a small volume menu with mute toggle and slider
function showVolumeMenu(rec, btn) {
	if (!rec) return;
	const existing = rec.tile.querySelector(".volume-menu");
	if (existing) {
		existing.remove();
		return;
	}
	const menu = document.createElement("div");
	menu.className = "menu volume-menu";
	const container = document.createElement("div");
	// compact container for volume menu
	container.style.display = "flex";
	container.style.flexDirection = "column";
	container.style.gap = "6px";
	container.style.padding = "4px 0";

	// No inline mute control here — use the bottom mute button for toggling.

	// Build a small custom track control (standard direction: left = min, right = max)
	// This keeps the fill and thumb aligned and pointer math robust during fast drags.
	const trackWrap = document.createElement("div");
	// vertical slider: narrow width, tall height
	trackWrap.className = "volume-track";
	trackWrap.style.width = "10px";
	trackWrap.style.height = "72px";
	trackWrap.style.position = "relative";
	trackWrap.style.cursor = "pointer";

	const fill = document.createElement("div");
	fill.className = "volume-fill";
	fill.style.position = "absolute";
	// Pad the fill inside the track border so visuals match the surrounding UI
	const pad = 3; // px padding on each side
	// For vertical: fill grows from the bottom upwards
	fill.style.left = pad + "px";
	fill.style.right = pad + "px";
	fill.style.bottom = pad + "px";
	fill.style.height = "0px";
	fill.style.borderRadius = "6px";

	const thumb = document.createElement("div");
	thumb.className = "volume-thumb";
	thumb.style.position = "absolute";
	thumb.style.left = "50%";
	thumb.style.transform = "translate(-50%,-50%)";
	thumb.style.width = "12px";
	thumb.style.height = "12px";
	thumb.style.borderRadius = "50%";
	trackWrap.appendChild(fill);
	trackWrap.appendChild(thumb);
	// center the track inside the narrow menu
	trackWrap.style.margin = "6px auto";
	container.appendChild(trackWrap);

	// make the container fill the menu so centering works predictably
	container.style.width = "100%";
	container.style.boxSizing = "border-box";
	menu.appendChild(container);
	// make the volume menu compact (match icon width)
	menu.style.boxSizing = "border-box";
	menu.style.minWidth = "32px";
	menu.style.width = "32px";
	menu.style.maxWidth = "32px";
	menu.style.display = "flex";
	menu.style.flexDirection = "column";
	menu.style.alignItems = "center";
	menu.style.visibility = "hidden";
	rec.tile.appendChild(menu);
	positionMenuNearButton(menu, btn, rec.tile);
	menu.style.visibility = "";

	const removeMenu = () => {
		try {
			menu.remove();
			document.removeEventListener("click", off);
		} catch {}
	};

	const setVisual = (v) => {
		// Standard mapping: left == min (0), right == max (1)
		const pct = Math.max(0, Math.min(1, v));
		// compute pixel sizes from the layout rect so we match pointer math for vertical layout
		const rect = trackWrap.getBoundingClientRect();
		const totalH = Math.max(0, rect.height || 160);
		const innerH = Math.max(0, totalH - pad * 2); // account for top/bottom padding
		// fill grows from the bottom upwards as volume increases
		const fillPx = Math.round(pct * innerH);
		fill.style.height = `${fillPx}px`;
		fill.style.bottom = pad + "px";
		// thumb sits at the top edge of the fill (centered via translate)
		const thumbTop = pad + (innerH - fillPx);
		thumb.style.top = `${thumbTop}px`;
		try {
			thumb.style.zIndex = "2";
			fill.style.zIndex = "1";
		} catch (_) {}
	};

	// compute volume from pointer position on the track: left -> max volume

	// Map pointer position to volume (standard: left = 0, right = 1)
	let dragging = false;
	let activePointerId = null;
	const updateFromPointer = (e) => {
		try {
			const rect = trackWrap.getBoundingClientRect();
			const totalH = Math.max(0, rect.height || 160);
			const innerH = Math.max(0, totalH - pad * 2);
			let y = e.clientY - rect.top - pad; // position inside inner area (0 = top)
			y = Math.max(0, Math.min(innerH, y));
			const ratio = innerH > 0 ? y / innerH : 0;
			// For vertical slider: top should be max -> volume = 1 - ratio
			const v = Math.max(0, Math.min(1, 1 - ratio));
			rec.volume = v;
			try {
				rec.video.volume = v;
			} catch {}
			rec.muted = v === 0;
			try {
				rec.video.muted = rec.muted;
			} catch {}
			// Preferences removed: do not persist volume/muted
			setVisual(v);
			updateMuteButtonUI(rec);
		} catch (e) {
			/* ignore */
		}
	};

	// Document-level handlers to make dragging robust even if pointer moves fast
	const docMove = (e) => {
		if (dragging) updateFromPointer(e);
	};
	const docUp = (e) => {
		if (activePointerId === e.pointerId) {
			dragging = false;
			activePointerId = null;
			try {
				trackWrap.releasePointerCapture?.(e.pointerId);
			} catch {}
			try {
				document.removeEventListener("pointermove", docMove);
				document.removeEventListener("pointerup", docUp);
			} catch {}
		}
	};

	trackWrap.addEventListener("pointerdown", (e) => {
		dragging = true;
		activePointerId = e.pointerId;
		updateFromPointer(e);
		try {
			trackWrap.setPointerCapture?.(e.pointerId);
		} catch {}
		// attach document handlers as a fallback
		try {
			document.addEventListener("pointermove", docMove);
			document.addEventListener("pointerup", docUp);
		} catch {}
	});
	trackWrap.addEventListener("pointermove", (e) => {
		if (!dragging) return;
		updateFromPointer(e);
	});
	trackWrap.addEventListener("pointerup", (e) => {
		docUp(e);
	});
	trackWrap.addEventListener("pointercancel", (e) => {
		docUp(e);
	});

	// initialize visuals from current volume
	try {
		setVisual(rec.video.volume || rec.volume || 1);
	} catch {
		setVisual(1);
	}

	const off = (ev) => {
		if (!menu.contains(ev.target)) removeMenu();
	};
	setTimeout(() => document.addEventListener("click", off));
}

function updateMuteButtonUI(rec) {
	try {
		const btn = rec.tile.querySelector('[data-action="mute"]');
		if (!btn) return;
		const icon = btn.firstElementChild;
		// prefer rec.muted/rec.volume when present (state source-of-truth)
		const isMuted =
			typeof rec.muted !== "undefined"
				? !!rec.muted
				: !!rec.video && !!rec.video.muted;
		const vol =
			typeof rec.volume === "number"
				? rec.volume
				: rec.video && typeof rec.video.volume === "number"
				? rec.video.volume
				: 1;
		if (isMuted || vol === 0) {
			btn.title = "Unmute";
			icon.className = "ri-volume-mute-line";
		} else {
			btn.title = "Mute";
			icon.className = vol > 0.5 ? "ri-volume-up-line" : "ri-volume-down-line";
		}
	} catch {}
}

function applySubtitleChoice(rec) {
	if (!rec) return;
	let choice = rec.subtitleChoice;
	// applySubtitleChoice invoked
	// disable native tracks first
	try {
		const tt = rec.video.textTracks || [];
		for (let i = 0; i < tt.length; i++) tt[i].mode = "disabled";
	} catch {}

	// normalize legacy formats: numeric -> hls:N, tN -> native:N
	try {
		if (choice && typeof choice !== "string") choice = String(choice);
		if (choice && /^[0-9]+$/.test(choice)) choice = `hls:${choice}`;
		if (choice && /^t\d+$/.test(choice)) choice = `native:${choice.slice(1)}`;
	} catch (e) {
		/* ignore */
	}

	// If this tile was auto-enabled for subtitles, and no explicit choice exists,
	// pick the first available HLS subtitleTrack, otherwise the first native textTrack.
	try {
		if (
			(rec._autoSubtitle || false) &&
			(!choice || choice === "Off" || choice === null)
		) {
			// prefer HLS-managed subtitleTracks
			if (
				rec.hls &&
				Array.isArray(rec.hls.subtitleTracks) &&
				rec.hls.subtitleTracks.length
			) {
				choice = `hls:0`;
			} else {
				const tt =
					rec.video && rec.video.textTracks ? rec.video.textTracks : [];
				for (let i = 0; i < tt.length; i++) {
					try {
						if (
							tt[i] &&
							(tt[i].kind === "subtitles" || tt[i].kind === "captions")
						) {
							choice = `native:${i}`;
							break;
						}
					} catch {}
				}
			}
		}
	} catch (e) {}

	// support an 'Auto' sentinel: pick a sensible subtitle track when available
	try {
		if (typeof choice === "string" && choice.startsWith("lang:")) {
			// requested language, e.g. lang:en
			const want = choice.split(":")[1] || "";
			let matched = false;
			// prefer HLS subtitleTracks that declare a language
			if (rec.hls && Array.isArray(rec.hls.subtitleTracks)) {
				for (let i = 0; i < rec.hls.subtitleTracks.length; i++) {
					const t = rec.hls.subtitleTracks[i];
					try {
						if (
							t &&
							t.lang &&
							t.lang.toLowerCase().startsWith(want.toLowerCase())
						) {
							choice = `hls:${i}`;
							matched = true;
							break;
						}
						if (
							t &&
							t.name &&
							t.name.toLowerCase().includes(want.toLowerCase())
						) {
							choice = `hls:${i}`;
							matched = true;
							break;
						}
					} catch {}
				}
			}
			// fallback: search native textTracks for matching language/label
			if (!matched) {
				const tt =
					rec.video && rec.video.textTracks ? rec.video.textTracks : [];
				for (let i = 0; i < tt.length; i++) {
					try {
						const t = tt[i];
						if (!t) continue;
						if (
							t.language &&
							t.language.toLowerCase().startsWith(want.toLowerCase())
						) {
							choice = `native:${i}`;
							matched = true;
							break;
						}
						if (t.label && t.label.toLowerCase().includes(want.toLowerCase())) {
							choice = `native:${i}`;
							matched = true;
							break;
						}
					} catch {}
				}
			}
			if (!matched) choice = "Off";
		}
	} catch (e) {
		/* ignore */
	}

	// handle Off
	if (!choice || choice === "Off") {
		try {
			if (rec.hls) {
				rec.hls.subtitleTrack = -1;
			}
		} catch (e) {
			console.error("hls.subtitleTrack off failed", e);
		}
		// ensure native tracks are disabled (done above)
		updateCcBadge(rec);
		return;
	}

	const parts = String(choice).split(":");
	const kind = parts[0];
	const num = parts.length > 1 ? Number(parts[1]) : NaN;

	if (kind === "native" && !Number.isNaN(num)) {
		try {
			if (rec.video.textTracks && rec.video.textTracks[num])
				rec.video.textTracks[num].mode = "showing";
		} catch (e) {
			console.debug("enable native textTrack failed", e);
		}
		try {
			if (rec.hls) rec.hls.subtitleTrack = -1;
		} catch (e) {
			/* ignore */
		}
		updateCcBadge(rec);
		return;
	}

	if (kind === "hls" && !Number.isNaN(num)) {
		// set hls subtitleTrack explicitly to the requested id
		try {
			if (rec.hls) {
				rec.hls.subtitleTrack = num;
			}
		} catch (e) {
			console.error("set hls.subtitleTrack failed", e);
		}

		// After selecting hls subtitle, try to enable matching textTrack or inject fallback
		setTimeout(() => {
			try {
				const tt = rec.video.textTracks || [];
				const htrack =
					rec.hls && rec.hls.subtitleTracks && rec.hls.subtitleTracks[num];
				let matched = false;
				if (htrack) {
					for (let i = 0; i < tt.length; i++) {
						const t = tt[i];
						if (
							(t.label && htrack.name && t.label === htrack.name) ||
							(t.language && htrack.lang && t.language === htrack.lang)
						) {
							try {
								t.mode = "showing";
								matched = true;
								break;
							} catch {}
						}
					}
				}
				// If no match found, heuristically enable a textTrack that looks like a VTT (kind subtitles)
				if (!matched && tt.length > 0) {
					for (let i = 0; i < tt.length; i++) {
						try {
							if (tt[i].kind === "subtitles" || tt[i].kind === "captions") {
								tt[i].mode = "showing";
								matched = true;
								break;
							}
						} catch {}
					}
				}
				if (!matched && tt.length > 0) {
					try {
						tt[0].mode = "showing";
						matched = true;
					} catch {}
				}
				if (!matched) {
					// no matching textTrack found for hls subtitle
					// fallback: try to inject a <track> element from subtitleTracks entry
					try {
						const info = rec.subtitleTracks && rec.subtitleTracks[num];
						if (info) {
							const candidate =
								info.url ||
								info.uri ||
								info.src ||
								(info.attrs && (info.attrs.URI || info.attrs.URI)) ||
								info._url ||
								info._uri;
							if (candidate) {
								try {
									const abs = new URL(candidate, rec.url).toString();
									try {
										if (rec._injectedVttTrack) {
											rec._injectedVttTrack.remove();
											rec._injectedVttTrack = null;
										}
									} catch {}
									const trackEl = document.createElement("track");
									trackEl.kind = "subtitles";
									trackEl.label = info.name || info.lang || `sub-${num}`;
									trackEl.srclang = info.lang || "";
									trackEl.src = abs;
									trackEl.default = false;
									rec.video.appendChild(trackEl);
									rec._injectedVttTrack = trackEl;
									trackEl.addEventListener("load", () => {
										try {
											if (trackEl.track) trackEl.track.mode = "showing";
											updateCcBadge(rec);
										} catch (e) {
											console.error("track load error", e);
										}
									});
									matched = true;
								} catch (e) {
									console.error("fallback track injection failed", e);
								}
							}
						}
					} catch (e) {
						console.log("fallback matching error", e);
					}
				}
			} catch (e) {
				console.log("error enabling textTrack after hls subtitle select", e);
			}
			updateCcBadge(rec);
		}, 250);
		return;
	}

	// Unknown format: fall back to disabling
	try {
		if (rec.hls) rec.hls.subtitleTrack = -1;
	} catch {}
	updateCcBadge(rec);
}

function updateCcBadge(rec) {
	try {
		const btn = rec.tile.querySelector('[data-action="cc"]');
		if (!btn) return;
		const badge = btn.querySelector(".cc-badge");
		if (!badge) return;
		const val = rec.subtitleChoice || "Off";
		if (!val || val === "Off") {
			badge.style.display = "none";
		} else {
			badge.style.display = "";
			try {
				if (typeof val === "string" && val.startsWith("native:")) {
					const idx = parseInt(val.split(":")[1]);
					badge.textContent =
						(rec.video.textTracks && rec.video.textTracks[idx]?.label) || "Sub";
				} else if (typeof val === "string" && val.startsWith("hls:")) {
					// show HLS label if available
					const idx = parseInt(val.split(":")[1]);
					const info =
						rec.hls && rec.hls.subtitleTracks && rec.hls.subtitleTracks[idx];
					badge.textContent =
						info && (info.name || info.lang) ? info.name || info.lang : "CC";
				} else {
					badge.textContent = "CC";
				}
			} catch {
				badge.textContent = "CC";
			}
		}
	} catch {}
}

// Show quality/resolution menu for Hls levels
function showQualityMenu(rec, btn) {
	if (!rec) return;
	const existing = rec.tile.querySelector(".quality-menu");
	if (existing) {
		existing.remove();
		return;
	}
	const menu = document.createElement("div");
	menu.className = "menu quality-menu";
	const ul = document.createElement("ul");
	// Offer each level (sorted highest resolution first), then Auto at the bottom
	const addItem = (label, cb, isActive) => {
		const li = document.createElement("li");
		const chk = document.createElement("span");
		chk.className = "check";
		chk.textContent = "✔";
		const txt = document.createElement("span");
		txt.textContent = label;
		li.appendChild(chk);
		li.appendChild(txt);
		if (isActive) li.classList.add("active");
		li.addEventListener("click", () => {
			cb();
			menu.remove();
		});
		ul.appendChild(li);
	};
	if (rec.levels && rec.levels.length) {
		// sort by pixel count if available, otherwise by bitrate
		const sorted = rec.levels.slice().sort((a, b) => {
			const aPixels = (a.width || 0) * (a.height || 0);
			const bPixels = (b.width || 0) * (b.height || 0);
			if (aPixels || bPixels) return bPixels - aPixels;
			return (b.bitrate || 0) - (a.bitrate || 0);
		});
		const current = rec.hls
			? typeof rec.hls.currentLevel !== "undefined"
				? rec.hls.currentLevel
				: rec.currentLevel || -1
			: rec.currentLevel || -1;
		sorted.forEach((l) => {
			const label =
				l.width && l.height
					? `${l.width}x${l.height} — ${Math.round(
							(l.bitrate || 0) / 1000
					  )} kbps`
					: `${Math.round((l.bitrate || 0) / 1000)} kbps`;
			addItem(
				label,
				() => {
					try {
						if (rec.hls) rec.hls.currentLevel = l.id;
						rec.preferredQuality = l.id;
					} catch {}
				},
				current === l.id
			);
		});
	} else {
		addItem("No quality info", () => {});
	}
	// Auto is always the last option
	// mark Auto as active when currentLevel === -1
	const current = rec.hls
		? typeof rec.hls.currentLevel !== "undefined"
			? rec.hls.currentLevel
			: rec.currentLevel || -1
		: rec.currentLevel || -1;
	addItem(
		"Auto",
		() => {
			try {
				if (rec.hls) {
					rec.hls.currentLevel = -1;
				}
				rec.preferredQuality = -1;
			} catch {}
		},
		current === -1
	);
	menu.appendChild(ul);
	menu.style.visibility = "hidden";
	rec.tile.appendChild(menu);
	positionMenuNearButton(menu, btn, rec.tile);
	menu.style.visibility = "";
	const off = (ev) => {
		if (!menu.contains(ev.target)) {
			menu.remove();
			document.removeEventListener("click", off);
		}
	};
	setTimeout(() => document.addEventListener("click", off));
}

// Position a menu element next to a clicked button, constrained to the tile bounds
function positionMenuNearButton(menu, btn, tile) {
	try {
		// measure sizes in tile-local coordinates
		const btnRect = btn.getBoundingClientRect();
		const tileRect = tile.getBoundingClientRect();
		// Use client sizes so we clamp to the tile's inner box
		const tileW = tile.clientWidth;
		const tileH = tile.clientHeight;
		// measure menu size after it's been appended (may be hidden)
		// allow compact sizing for the volume menu
		const isVolume =
			menu.classList &&
			menu.classList.contains &&
			menu.classList.contains("volume-menu");
		// prefer the actual offset size, fall back to compact defaults for volume menus
		const menuW = Math.round(menu.offsetWidth || (isVolume ? 34 : 220));
		const menuH = Math.round(menu.offsetHeight || (isVolume ? 96 : 160));

		// compute button position relative to tile top-left
		const btnLeftRel = Math.round(btnRect.left - tileRect.left);
		const btnRightRel = Math.round(btnRect.right - tileRect.left);
		const btnTopRel = Math.round(btnRect.top - tileRect.top);
		const btnBottomRel = Math.round(btnRect.bottom - tileRect.top);

		// horizontal: for volume menus, center over the button; otherwise align right edge
		let left;
		if (isVolume) {
			// try to center the menu horizontally over the button
			const btnCenter = Math.round(
				(btnRect.left + btnRect.right) / 2 - tileRect.left
			);
			left = btnCenter - Math.round(menuW / 2);
		} else {
			left = btnRightRel - menuW + 8;
		}
		if (left + menuW > tileW - 6) left = tileW - menuW - 6;
		if (left < 6) left = 6;

		// vertical: prefer above the button if there's enough space; otherwise below
		const spaceAbove = btnTopRel;
		let top;
		if (spaceAbove >= menuH + 8) {
			// place above
			top = btnTopRel - menuH - 6;
		} else {
			// place below, but clamp to tile bottom
			top = btnBottomRel + 6;
			if (top + menuH > tileH - 6) top = Math.max(6, tileH - menuH - 6);
		}

		menu.style.right = "auto";
		menu.style.left = `${left}px`;
		menu.style.top = `${top}px`;
		menu.style.minWidth = `${menuW}px`;
		// ensure overflow doesn't show outside tile
		menu.style.maxWidth = `${Math.max(120, tileW - 12)}px`;
		menu.style.maxHeight = `${Math.max(40, tileH - 12)}px`;
		menu.style.overflow = "auto";
	} catch (e) {
		/* fallback to CSS defaults */
	}
}

function hardRefresh(rec) {
	try {
		if (rec.hls) {
			rec.hls.stopLoad();
			rec.hls.detachMedia();
			rec.hls.attachMedia(rec.video);
			rec.hls.loadSource(rec._activeUrl || rec.url);
		} else {
			rec.video.pause();
			const u = new URL(rec._activeUrl || rec.url, window.location.href);
			u.searchParams.set("_ts", Date.now().toString());
			rec.video.src = "";
			rec.video.load();
			rec.video.src = u.toString();
			rec.video.play().catch(() => {});
		}
	} catch {
		setupPlayer(rec);
	}
}

function showUnsupported(tile) {
	const msg = document.createElement("div");
	msg.style.position = "absolute";
	msg.style.inset = "0";
	msg.style.display = "grid";
	msg.style.placeItems = "center";
	msg.style.background = "linear-gradient(180deg,#0a0f15,#0c121a)";
	msg.style.color = "#ffb4b4";
	msg.style.fontSize = "14px";
	msg.style.padding = "12px";
	msg.textContent = "HLS not supported in this browser.";
	tile.appendChild(msg);
}

/* Error handling helpers: preflight manifests, tile error UI, and HLS error handling
           - preflightManifest(url): quick fetch to detect 404/CORS/non-m3u8 before creating Hls
           - showTileError / clearTileErrorUI: overlay inside tile with Retry/Remove actions
           - handleHlsError: centralized hls.js ERROR handler that uses soft/heavy recovery
        */
async function preflightManifest(url, timeoutMs = 5000) {
	try {
		const controller = new AbortController();
		const id = setTimeout(() => controller.abort(), timeoutMs);
		const resp = await fetch(url, {
			method: "GET",
			mode: "cors",
			signal: controller.signal,
		});
		clearTimeout(id);
		if (!resp.ok)
			return { ok: false, status: resp.status, statusText: resp.statusText };
		const text = await resp.text();
		if (!text || !text.includes("#EXTM3U"))
			return {
				ok: false,
				reason: "not-m3u8",
				textSnippet: text && text.slice ? text.slice(0, 200) : "",
			};
		return { ok: true };
	} catch (err) {
		if (err && err.name === "AbortError")
			return { ok: false, reason: "timeout" };
		return { ok: false, reason: "network", error: err };
	}
}

function clearTileErrorUI(rec) {
	try {
		if (!rec || !rec.tile) return;
		const existing = rec.tile.querySelector(".tile-error");
		if (existing) existing.remove();
	} catch {}
}

function showTileError(rec, message = "Stream unavailable", options = {}) {
	try {
		if (!rec || !rec.tile) return;
		clearTileErrorUI(rec);
		// stop health checks and cancel pending reconnects while showing persistent error
		try {
			stopHealthCheck(rec);
		} catch {}
		try {
			clearTimeout(rec._reconnectTimer);
		} catch {}
		try {
			clearTimeout(rec._heavyTimer);
		} catch {}
		try {
			if (rec._hideSpinner) rec._hideSpinner();
		} catch {}
		const overlay = document.createElement("div");
		overlay.className = "tile-error";
		overlay.style.position = "absolute";
		overlay.style.inset = "0";
		overlay.style.display = "flex";
		overlay.style.flexDirection = "column";
		overlay.style.gap = "8px";
		overlay.style.alignItems = "center";
		overlay.style.justifyContent = "center";
		overlay.style.zIndex = "50";
		overlay.style.background =
			"linear-gradient(180deg, rgba(6,8,10,0.6), rgba(6,8,10,0.6))";
		overlay.style.color = "#fff";
		overlay.style.padding = "12px";
		overlay.style.textAlign = "center";
		overlay.style.pointerEvents = "auto";
		const msg = document.createElement("div");
		msg.textContent = message;
		msg.style.maxWidth = "90%";
		msg.style.fontSize = "13px";
		const btnRow = document.createElement("div");
		btnRow.style.display = "flex";
		btnRow.style.gap = "8px";
		const retry = document.createElement("button");
		retry.textContent = options.retryLabel || "Retry";
		retry.style.padding = "6px 10px";
		const remove = document.createElement("button");
		remove.textContent = options.removeLabel || "Remove";
		remove.style.padding = "6px 10px";
		btnRow.appendChild(retry);
		btnRow.appendChild(remove);
		overlay.appendChild(msg);
		overlay.appendChild(btnRow);
		rec.tile.appendChild(overlay);

		retry.addEventListener("click", (e) => {
			try {
				clearTileErrorUI(rec);
				rec.errorAttempts = 0;
				setupPlayer(rec);
			} catch {}
		});
		remove.addEventListener("click", (e) => {
			try {
				destroyTile(rec.tile, rec.url);
				layoutGrid();
			} catch {}
		});
	} catch {}
}

// Centralized HLS error handling that delegates to existing soft reconnects or performs a heavier rebuild
function handleHlsError(rec, data) {
	try {
		if (!rec) return;
		const { type, details, fatal } = data || {};
		console.warn("HLS error", rec.url, type, details, fatal);
		// non-fatal: try targeted nudges
		if (!fatal) {
			if (
				details === Hls.ErrorDetails.FRAG_LOAD_ERROR ||
				details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT ||
				details === Hls.ErrorDetails.LEVEL_LOAD_ERROR
			) {
				// nudge loader
				try {
					if (rec.hls) {
						// prefer loading relative to current playhead so we don't jump to live
						try {
							const pos =
								rec.video && typeof rec.video.currentTime === "number"
									? rec.video.currentTime
									: -1;
							if (pos >= 0) rec.hls.startLoad(pos);
							else rec.hls.startLoad();
						} catch (_) {
							try {
								rec.hls.startLoad();
							} catch (_) {}
						}
					}
				} catch {}
				scheduleReconnect(rec);
				return;
			}
			// other non-fatal items: schedule a reconnect
			scheduleReconnect(rec);
			return;
		}

		// fatal errors: decide based on type
		rec.errorAttempts = (rec.errorAttempts || 0) + 1;
		const maxAttempts = 5;
		if (rec.errorAttempts > maxAttempts) {
			showTileError(
				rec,
				`Failed to play after ${rec.errorAttempts} attempts. ${details || ""}`
			);
			return;
		}

		if (type === Hls.ErrorTypes.MEDIA_ERROR) {
			try {
				if (rec.hls) {
					rec.hls.recoverMediaError();
				}
			} catch (e) {
				/* fallthrough to rebuild */
			}
			// give it a moment then soft heal
			setTimeout(() => {
				try {
					softHeal(rec);
				} catch {
					setupPlayer(rec);
				}
			}, 800);
			return;
		}

		if (type === Hls.ErrorTypes.NETWORK_ERROR) {
			// network problems are often transient; schedule a heavier recovery with backoff
			const base = 1000;
			const delay = Math.min(
				30000,
				Math.round(
					base *
						Math.pow(2, Math.max(0, rec.errorAttempts - 1)) *
						(0.8 + Math.random() * 0.4)
				)
			);
			showTileError(
				rec,
				`Network error — retrying in ${Math.round(delay / 1000)}s...`
			);
			clearTimeout(rec._heavyTimer);
			rec._heavyTimer = setTimeout(() => {
				try {
					if (rec.hls) {
						rec.hls.destroy();
						rec.hls = null;
					}
				} catch {}
				try {
					setupPlayer(rec);
				} catch {}
			}, delay);
			return;
		}

		// default: attempt a rebuild after a short delay
		const delay = 1000 * Math.min(8, rec.errorAttempts);
		showTileError(
			rec,
			`Playback error — retrying in ${Math.round(delay / 1000)}s...`
		);
		clearTimeout(rec._heavyTimer);
		rec._heavyTimer = setTimeout(() => {
			try {
				if (rec.hls) {
					rec.hls.destroy();
					rec.hls = null;
				}
				setupPlayer(rec);
			} catch {}
		}, delay);
	} catch (e) {
		console.error("handleHlsError failed", e);
	}
}

function resetBackoff(rec) {
	rec.backoffMs = 0;
}

// Do NOT reconnect while hidden; queue a soft heal instead
function scheduleReconnect(rec) {
	if (document.hidden) {
		rec.needsHeal = true;
		return;
	}
	rec.backoffMs = rec.backoffMs ? Math.min(rec.backoffMs * 2, 30000) : 1000;
	clearTimeout(rec._reconnectTimer);
	rec._reconnectTimer = setTimeout(() => softHeal(rec), rec.backoffMs);
}

// Soft heal: try to resume without reloading the source
function softHeal(rec) {
	try {
		if (rec.hls) {
			// Don’t stop/detach; just nudge loader/decoder. Use currentTime when possible so we don't jump to live
			try {
				const pos =
					rec.video && typeof rec.video.currentTime === "number"
						? rec.video.currentTime
						: -1;
				if (pos >= 0) rec.hls.startLoad(pos);
				else rec.hls.startLoad();
			} catch (e) {
				try {
					rec.hls.startLoad();
				} catch (_) {}
			}
			try {
				rec.hls.recoverMediaError();
			} catch {}
		}
		rec.video.play().catch(() => {});
		resetBackoff(rec);
	} catch {
		// As a last resort, rebuild
		setupPlayer(rec);
	}
}

// Update the latency / buffered time UI on the tile
function updateLatencyUI(rec) {
	try {
		if (!rec || !rec.tile) return;
		const badge = rec.tile.querySelector(".latency-badge");
		if (!badge) return;
		// Compute approximate buffer/latency for live-ish streams
		// Strategy: use hls.liveSyncPosition when available; otherwise approximate using buffered end - currentTime
		let secs = NaN;
		if (rec.hls && typeof rec.hls.liveSyncPosition === "number") {
			// latency ~ liveSyncPosition - currentTime
			const pos = rec.hls.liveSyncPosition || 0;
			secs = Math.max(
				0,
				pos - (rec.video && rec.video.currentTime ? rec.video.currentTime : 0)
			);
		} else {
			try {
				const v = rec.video;
				if (v && v.buffered && v.buffered.length) {
					const end = v.buffered.end(v.buffered.length - 1);
					secs = Math.max(0, end - (v.currentTime || 0));
				}
			} catch {}
		}
		if (!Number.isFinite(secs)) {
			badge.textContent = "";
			// remove live marker if we can't compute
			try {
				const btn = rec.tile.querySelector('[data-action="live"]');
				if (btn) btn.classList.remove("is-live");
			} catch {}
			return;
		}
		const txt = `${secs.toFixed(1)}s`;
		badge.textContent = txt;
		// mark the live button when below threshold
		try {
			const btn = rec.tile.querySelector('[data-action="live"]');
			if (btn) {
				if (secs <= LIVE_THRESHOLD) btn.classList.add("is-live");
				else btn.classList.remove("is-live");
			}
		} catch {}
	} catch (e) {}
}

// Jump to live (seek near the live edge); for hls.js use hls.liveSyncPosition or set currentTime to buffered end
function gotoLive(rec) {
	try {
		if (!rec || !rec.video) return;
		// If HLS has API for live, set to live edge
		if (rec.hls && typeof rec.hls.liveSyncPosition === "number") {
			try {
				const livePos = rec.hls.liveSyncPosition || 0;
				// seek slightly ahead of liveSyncPosition to be at edge
				rec.video.currentTime = Math.max(0, livePos - 0.3);
				rec.video.play().catch(() => {});
				return;
			} catch {}
		}
		// Fallback: seek to buffered end minus small offset
		try {
			const v = rec.video;
			if (v && v.buffered && v.buffered.length) {
				const end = v.buffered.end(v.buffered.length - 1);
				v.currentTime = Math.max(0, end - 0.5);
				v.play().catch(() => {});
			}
		} catch {}
	} catch (e) {}
}

function startHealthCheck(rec) {
	rec.lastTime = 0;
	rec.healthTimer = setInterval(() => {
		if (document.hidden) return; // skip checks while hidden
		const v = rec.video;
		if (!v || v.readyState === 0) return;
		const now = v.currentTime;
		if (!v.paused && Math.abs(now - rec.lastTime) < 0.1) {
			scheduleReconnect(rec);
		}
		rec.lastTime = now;
	}, 10000);
}
function stopHealthCheck(rec) {
	if (rec.healthTimer) clearInterval(rec.healthTimer);
	rec.healthTimer = null;
}

// On visibility return, apply queued soft heals; do not reload sources
document.addEventListener("visibilitychange", () => {
	if (!document.hidden) {
		for (const [, rec] of players.entries()) {
			if (rec.needsHeal) {
				rec.needsHeal = false;
				softHeal(rec);
			} else {
				// Even if not queued, some browsers auto-pause; just try to resume
				rec.video.play().catch(() => {});
			}
		}
	}
});

// Only heal on actual network change (softly)
window.addEventListener("online", () => {
	for (const [, rec] of players.entries()) {
		setTimeout(() => {
			softHeal(rec);
		}, Math.floor(Math.random() * 500));
	}
});

function destroyTile(el, url) {
	for (const [key, rec] of players.entries()) {
		if (rec.tile === el) {
			try {
				stopHealthCheck(rec);
				clearTimeout(rec._reconnectTimer);
				clearTimeout(rec._heavyTimer);
				clearInterval(rec._latencyTimer);
				if (rec.hls) rec.hls.destroy();
				rec.video.pause();
				rec.video.src = "";
				rec.video.load();
			} catch {}
			players.delete(key);
			break;
		}
	}
	// remove the matching entry by instanceId if available, fallback to URL
	try {
		const rec = getRecByTile(el);
		if (rec && rec.instanceId) {
			const idx = streamEntries.findIndex(
				(e) => e.instanceId === rec.instanceId
			);
			if (idx !== -1) streamEntries.splice(idx, 1);
		} else {
			const idx = streamEntries.findIndex((e) => e.url === url);
			if (idx !== -1) streamEntries.splice(idx, 1);
		}
	} catch {}
	try {
		saveList();
	} catch {}
	// previously removed unmute overlay; nothing to clean up
	el.remove();
	updateEmptyState();
}

function removeAllTiles(save = true) {
	for (const [, rec] of players.entries()) {
		try {
			stopHealthCheck(rec);
			clearTimeout(rec._reconnectTimer);
			clearTimeout(rec._heavyTimer);
			clearInterval(rec._latencyTimer);
			if (rec.hls) rec.hls.destroy();
			rec.video.pause();
			rec.video.src = "";
			rec.video.load();
			try {
				if (rec._debugTimer) clearInterval(rec._debugTimer);
				rec._debugTimer = null;
				rec._debugEvents = null;
			} catch {}
			rec.tile.remove();
		} catch {}
	}
	players.clear();
	streamEntries.splice(0, streamEntries.length);
	try {
		if (save) saveList();
	} catch {}
	updateEmptyState();
}

// Fit-all layout
function layoutGrid() {
	const tiles = [...grid.children].filter((el) =>
		el.classList.contains("tile")
	);
	const n = tiles.length;
	if (n === 0) {
		grid.style.gridTemplateColumns = "1fr";
		grid.style.gridAutoRows = "1fr";
		return;
	}
	const gap =
		parseFloat(getComputedStyle(grid).getPropertyValue("--gap")) || 10;
	const vw = document.documentElement.clientWidth,
		vh = window.innerHeight;
	const toolbarRect = toolbar.getBoundingClientRect();
	const availableW = vw - 2 * 6;
	const availableH = vh - toolbarRect.height - 2 * 6;
	const aspectW = 16,
		aspectH = 9;
	let bestCols = 1,
		bestScale = 0;
	for (let cols = 1; cols <= n; cols++) {
		const rows = Math.ceil(n / cols);
		const totalGapW = gap * (cols - 1),
			totalGapH = gap * (rows - 1);
		const cellW = (availableW - totalGapW) / cols,
			cellH = (availableH - totalGapH) / rows;
		if (cellW <= 0 || cellH <= 0) continue;
		const scale = Math.min(cellW / aspectW, cellH / aspectH);
		if (scale > bestScale) {
			bestScale = scale;
			bestCols = cols;
		}
	}
	const tileW = Math.floor(aspectW * bestScale),
		tileH = Math.floor(aspectH * bestScale);
	grid.style.gridTemplateColumns = `repeat(${bestCols}, ${tileW}px)`;
	grid.style.gridAutoRows = `${tileH}px`;
}

const ro = new ResizeObserver(() => layoutGrid());
ro.observe(document.documentElement);
ro.observe(grid);
ro.observe(toolbar);
window.addEventListener("orientationchange", () => setTimeout(layoutGrid, 50));
window.addEventListener("resize", () => layoutGrid());

function getRecByTile(tile) {
	for (const [, rec] of players.entries()) if (rec.tile === tile) return rec;
	return null;
}

(function init() {
	// load persisted settings before creating tiles
	try {
		loadSettings();
	} catch {}
	// ensure toolbar state matches restored view mode
	try {
		updateToolbarState();
	} catch {}
	try {
		// prefer stored feed mode (preset) over saved custom list when present
		const mode =
			typeof feedSelector !== "undefined" && feedSelector
				? localStorage.getItem("mv_viewMode") || feedSelector.value
				: null;
		if (mode && mode !== "custom") {
			if (feedSelector) feedSelector.value = mode;
			loadPresets(mode);
			return;
		}
	} catch (e) {
		/* fall back to loading saved list */
	}

	const saved = loadList();
	if (saved.length) {
		saved.forEach((entry) => {
			streamEntries.push(entry);
			addStreamTile(entry.url, entry.instanceId);
		});
		// apply showDebugByDefault to any created recs
		try {
			if (settings && settings.showDebugByDefault) {
				for (const [, rec] of players.entries()) {
					try {
						const panel = rec.tile.querySelector(".debug-panel");
						const btn = rec.tile.querySelector('[data-action="debug"]');
						if (panel) panel.style.display = "block";
						if (btn && btn.setAttribute)
							btn.setAttribute("aria-pressed", "true");
					} catch {}
				}
			}
			// apply subtitles-by-default to newly-created recs that were marked Auto
			try {
				if (settings && settings.showSubtitlesByDefault) {
					for (const [, rec] of players.entries()) {
						try {
							if (rec._autoSubtitle) {
								// immediate attempt
								applySubtitleChoice(rec);
								updateCcBadge(rec);
								// retry a couple of times to allow HLS/native tracks to appear
								setTimeout(() => {
									try {
										if (rec._autoSubtitle) {
											applySubtitleChoice(rec);
											updateCcBadge(rec);
										}
									} catch {}
								}, 500);
								setTimeout(() => {
									try {
										if (rec._autoSubtitle) {
											applySubtitleChoice(rec);
											updateCcBadge(rec);
										}
									} catch {}
								}, 2000);
							}
						} catch {}
					}
				}
			} catch {}
		} catch {}
	} else {
		updateEmptyState();
		layoutGrid();
	}
})();

// Global URL drag-and-drop: allow dropping a .m3u8 link anywhere to add it
// Avoid interfering with tile reordering by ignoring drops while a tile is dragging
(function setupGlobalDrop() {
	const isUuid = (s) =>
		typeof s === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			s
		);
	const extractUrls = (dt) => {
		try {
			let text = "";
			try {
				text = dt.getData("text/uri-list") || "";
			} catch {}
			if (!text) {
				try {
					text = dt.getData("text/plain") || "";
				} catch {}
			}
			if (!text) return [];
			// text/uri-list may contain comments starting with '#'
			const cleaned = text
				.split(/\r?\n|\s+/)
				.map((l) => l.trim())
				.filter((l) => l && !l.startsWith("#"))
				.join("\n");
			const tokens = cleaned.split(/[,\s\n]+/).map((t) => t.trim());
			const urls = tokens.filter(
				(t) => /^https?:\/\//i.test(t) && t.toLowerCase().includes(".m3u8")
			);
			return Array.from(new Set(urls));
		} catch {
			return [];
		}
	};
	const ensureCustomThen = (fn) => {
		try {
			if (feedSelector && feedSelector.value !== "custom") {
				feedSelector.value = "custom";
				try {
					feedSelector.dispatchEvent(new Event("change"));
				} catch {}
				setTimeout(fn, 50);
			} else fn();
		} catch {
			fn();
		}
	};
	// Indicate we accept link drops when appropriate
	window.addEventListener("dragover", (e) => {
		try {
			// If a tile is being dragged for reordering, let that flow handle events
			if (document.querySelector(".tile.dragging")) return;
			const types = (e.dataTransfer && e.dataTransfer.types) || [];
			const hasUrl = Array.from(types).some(
				(t) =>
					(t + "").toLowerCase().includes("uri") ||
					(t + "").toLowerCase().includes("text")
			);
			if (hasUrl) {
				// If the payload is a tile instanceId, don't treat it as a URL drop
				const txt =
					(e.dataTransfer && (e.dataTransfer.getData("text/plain") || "")) ||
					"";
				if (isUuid(txt) && streamEntries.some((se) => se.instanceId === txt))
					return;
				e.preventDefault(); // allow drop
			}
		} catch {}
	});
	window.addEventListener("drop", (e) => {
		try {
			// If a tile is being dragged for reordering, ignore
			if (document.querySelector(".tile.dragging")) return;
			const dt = e.dataTransfer;
			if (!dt) return;
			const txt = (dt.getData("text/plain") || "").trim();
			if (isUuid(txt) && streamEntries.some((se) => se.instanceId === txt))
				return; // reordering payload
			const urls = extractUrls(dt);
			if (!urls.length) return;
			e.preventDefault();
			e.stopPropagation();
			ensureCustomThen(() => addUrls(urls));
		} catch {}
	});
})();

// Post-init: ensure any recs created by presets or saved lists that were
// marked with subtitleChoice === 'Auto' get a chance to enable subtitles
// once HLS/native tracks become available. Retry a few times with delays.
setTimeout(() => {
	try {
		if (settings && settings.showSubtitlesByDefault) {
			for (const [, rec] of players.entries()) {
				try {
					if (rec && rec._autoSubtitle) {
						applySubtitleChoice(rec);
						updateCcBadge(rec);
					}
				} catch {}
			}
		}
	} catch {}
}, 400);
setTimeout(() => {
	try {
		if (settings && settings.showSubtitlesByDefault) {
			for (const [, rec] of players.entries()) {
				try {
					if (rec && rec._autoSubtitle) {
						applySubtitleChoice(rec);
						updateCcBadge(rec);
					}
				} catch {}
			}
		}
	} catch {}
}, 1500);
setTimeout(() => {
	try {
		if (settings && settings.showSubtitlesByDefault) {
			for (const [, rec] of players.entries()) {
				try {
					if (rec && rec._autoSubtitle) {
						applySubtitleChoice(rec);
						updateCcBadge(rec);
					}
				} catch {}
			}
		}
	} catch {}
}, 4000);

// Threshold (seconds) below which we consider the stream 'live' (approximate, like YouTube)
const LIVE_THRESHOLD = 3.0; // seconds
