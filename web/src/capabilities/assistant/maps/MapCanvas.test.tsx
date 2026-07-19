import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installLocalStorage } from "../../../__tests__/localStorage";
import type { GeoResult } from "./api";

// MapCanvas is the right-side maps drawer. We mock maplibre-gl ENTIRELY (no real WebGL in
// jsdom) and mock ./api's geocode so no network runs. The behavior under test is the
// pin-accumulation pipeline: resolve each requested place, retry the misses with a
// shared region hint, render a numbered pin per success and a failed chip per miss.

// --- maplibre-gl mock -------------------------------------------------------------------
// Capture the constructed instances so assertions can inspect markers/fitBounds calls.
const mapInstances: MockMap[] = [];
const markerInstances: MockMarker[] = [];

class MockMap {
  addControl = vi.fn();
  on = vi.fn((_ev: string, cb: () => void) => cb());
  remove = vi.fn();
  resize = vi.fn();
  fitBounds = vi.fn();
  flyTo = vi.fn();
  constructor() {
    mapInstances.push(this);
  }
}

class MockMarker {
  setLngLat = vi.fn(() => this);
  setPopup = vi.fn(() => this);
  addTo = vi.fn(() => this);
  constructor() {
    markerInstances.push(this);
  }
}

class MockPopup {
  setText = vi.fn(() => this);
}

class MockBounds {
  extend = vi.fn(() => this);
}

vi.mock("maplibre-gl", () => ({
  default: {
    Map: MockMap,
    Marker: MockMarker,
    Popup: MockPopup,
    NavigationControl: vi.fn(),
    LngLatBounds: MockBounds,
    Protocol: vi.fn(() => ({ tile: vi.fn(), add: vi.fn() })),
    addProtocol: vi.fn(),
  },
}));

// The CSS import is a no-op in jsdom but resolve it to nothing to be safe.
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));

// pmtiles + protomaps-themes-base are only touched when the self-hosted basemap is ready;
// we keep the basemap-status fetch returning not-ready so they aren't exercised, but mock
// them anyway so importing MapCanvas never reaches the real heavy modules.
vi.mock("pmtiles", () => ({
  FetchSource: vi.fn(),
  PMTiles: vi.fn(),
  Protocol: vi.fn(() => ({ tile: vi.fn(), add: vi.fn() })),
}));
vi.mock("protomaps-themes-base", () => ({ default: () => [] }));

// --- ./api (geocode) mock ---------------------------------------------------------------
const geocode = vi.fn();
const rememberGeo = vi.fn();
vi.mock("./api", () => ({
  geocode: (...a: unknown[]) => geocode(...a),
  rememberGeo: (...a: unknown[]) => rememberGeo(...a),
}));

function geo(name: string, displayName: string, lat = 38, lng = -9): GeoResult {
  return { query: name, lat, lng, displayName, bbox: null };
}

function geoBbox(name: string, displayName: string): GeoResult {
  return { query: name, lat: 38.7, lng: -9.1, displayName, bbox: [38.6, 38.8, -9.2, -9.0] };
}

let MapCanvas: typeof import("./MapCanvas").MapCanvas;

beforeEach(async () => {
  installLocalStorage();
  mapInstances.length = 0;
  markerInstances.length = 0;
  geocode.mockReset();
  rememberGeo.mockReset();
  // resolveStyle fetches basemap-status; keep it "not ready" so it uses a hosted style.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ready: false }))));
  ({ MapCanvas } = await import("./MapCanvas"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MapCanvas — creation", () => {
  test("creates a map and wires a navigation control", async () => {
    geocode.mockResolvedValue(null);
    render(<MapCanvas requests={[]} onClose={() => {}} />);
    await waitFor(() => expect(mapInstances.length).toBe(1));
    expect(mapInstances[0].addControl).toHaveBeenCalled();
    // MapCanvas renders the inner drawer content (header + close), not its own aside — the
    // animated .cap-drawer shell lives in CapabilitySurface now.
    expect(screen.getByRole("button", { name: "Close map" })).toBeInTheDocument();
    expect(document.querySelector("aside")).toBeNull();
  });

  test("Close button fires onClose", async () => {
    geocode.mockResolvedValue(null);
    const onClose = vi.fn();
    render(<MapCanvas requests={[]} onClose={onClose} />);
    await waitFor(() => expect(mapInstances.length).toBe(1));
    await userEvent.click(screen.getByRole("button", { name: "Close map" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("MapCanvas — pin accumulation", () => {
  test("resolves each request to a numbered pin in the list, dropping the comma tail", async () => {
    geocode.mockImplementation(async (q: string) =>
      q.includes("Belém") ? geo(q, "Belém Tower, Lisbon, Portugal") : geo(q, "Alfama, Lisbon, Portugal"),
    );
    render(<MapCanvas requests={["Belém Tower, Lisbon", "Alfama, Lisbon"]} onClose={() => {}} />);

    // Two pins land, each labeled by the first comma-segment of its payload.
    await waitFor(() => expect(screen.getByRole("button", { name: /Belém Tower/ })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Alfama/ })).toBeInTheDocument();
    // A marker was added to the map for each resolved place.
    await waitFor(() => expect(markerInstances.length).toBe(2));
    // Numbered 1 and 2.
    const pins = screen.getAllByRole("button").filter((b) => b.classList.contains("map-pin"));
    expect(pins[0]).toHaveTextContent("1");
    expect(pins[1]).toHaveTextContent("2");
  });

  test("clicking a resolved pin flies the map to it", async () => {
    geocode.mockResolvedValue(geo("Lisbon", "Lisbon, Portugal", 38.7, -9.1));
    render(<MapCanvas requests={["Lisbon"]} onClose={() => {}} />);
    const pin = await screen.findByRole("button", { name: /Lisbon/ });
    await userEvent.click(pin);
    // Single pin with no bbox -> flyTo (frameAll's single-pin path also uses flyTo).
    await waitFor(() => expect(mapInstances[0].flyTo).toHaveBeenCalled());
  });

  test("a single resolved pin frames via flyTo (no bbox)", async () => {
    geocode.mockResolvedValue(geo("Lisbon", "Lisbon, Portugal"));
    render(<MapCanvas requests={["Lisbon"]} onClose={() => {}} />);
    await screen.findByRole("button", { name: /Lisbon/ });
    await waitFor(() => expect(mapInstances[0].flyTo).toHaveBeenCalled());
  });

  test("two resolved pins frame all via fitBounds", async () => {
    geocode.mockImplementation(async (q: string) => geo(q, `${q}, Portugal`, 38 + q.length * 0.01, -9));
    render(<MapCanvas requests={["Porto", "Faro"]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Porto/ })).toBeInTheDocument());
    await waitFor(() => expect(mapInstances[0].fitBounds).toHaveBeenCalled());
  });
});

describe("MapCanvas — region-hint retry", () => {
  test("a place that misses directly is retried with the shared region hint, then remembered", async () => {
    // First two resolve in "Paris, France"; the third only resolves once the hint is appended.
    geocode.mockImplementation(async (q: string) => {
      if (q === "Louvre") return geo(q, "Louvre, Paris, France");
      if (q === "Eiffel Tower") return geo(q, "Eiffel Tower, Paris, France");
      if (q === "Odéon Square, Paris, France") return geo(q, "Odéon Square, Paris, France");
      return null; // bare "Odéon Square" misses
    });
    render(<MapCanvas requests={["Louvre", "Eiffel Tower", "Odéon Square"]} onClose={() => {}} />);

    // The retried place lands as a pin (under its original short label).
    await waitFor(() => expect(screen.getByRole("button", { name: /Odéon Square/ })).toBeInTheDocument());
    // The hint-resolved query was the original + ", <hint>".
    expect(geocode).toHaveBeenCalledWith(expect.stringMatching(/^Odéon Square, /));
    // A successful retry is remembered so a refresh re-pins the bare name directly.
    expect(rememberGeo).toHaveBeenCalledWith("Odéon Square", expect.objectContaining({ displayName: expect.any(String) }));
    // No failed chips.
    expect(document.querySelector(".map-pin.failed")).toBeNull();
  });
});

describe("MapCanvas — failed geocode chips", () => {
  test("an unresolvable place renders a failed chip linking to OpenStreetMap search", async () => {
    geocode.mockResolvedValue(null); // everything misses (and the retry also misses)
    render(<MapCanvas requests={["Nowheresville"]} onClose={() => {}} />);

    const chip = await waitFor(() => {
      const el = document.querySelector("a.map-pin.failed") as HTMLAnchorElement | null;
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(chip.textContent).toContain("Nowheresville");
    expect(chip.getAttribute("href")).toContain("openstreetmap.org/search");
    expect(chip.getAttribute("href")).toContain(encodeURIComponent("Nowheresville"));
    // No markers added for a total miss.
    expect(markerInstances.length).toBe(0);
  });

  test("a mix of one hit and one miss shows a pin AND a failed chip", async () => {
    geocode.mockImplementation(async (q: string) => (q === "Lisbon" ? geo(q, "Lisbon, Portugal") : null));
    render(<MapCanvas requests={["Lisbon", "Ghosttown"]} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Lisbon/ })).toBeInTheDocument());
    await waitFor(() => expect(document.querySelector("a.map-pin.failed")).not.toBeNull());
    expect(screen.getByText(/Ghosttown/)).toBeInTheDocument();
  });
});

describe("MapCanvas — bbox framing + basemap + resize", () => {
  test("a pin with a bbox frames via fitBounds (flyTo's bbox branch)", async () => {
    geocode.mockResolvedValue(geoBbox("Lisbon", "Lisbon, Portugal"));
    render(<MapCanvas requests={["Lisbon"]} onClose={() => {}} />);
    const pin = await screen.findByRole("button", { name: /Lisbon/ });
    await userEvent.click(pin); // focus -> flyTo -> bbox branch -> fitBounds
    await waitFor(() => expect(mapInstances[0].fitBounds).toHaveBeenCalled());
  });

  test("uses the self-hosted protomaps style when the basemap is ready", async () => {
    // basemap-status reports ready -> ensureProtocol + protomapsStyle path.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ready: true }))));
    geocode.mockResolvedValue(null);
    render(<MapCanvas requests={[]} onClose={() => {}} />);
    await waitFor(() => expect(mapInstances.length).toBe(1));
    // A Map was still constructed (with the resolved style object).
    expect(mapInstances[0].addControl).toHaveBeenCalled();
  });

  test("a failed basemap-status falls back to a hosted style", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    geocode.mockResolvedValue(null);
    render(<MapCanvas requests={[]} onClose={() => {}} />);
    await waitFor(() => expect(mapInstances.length).toBe(1));
  });

  test("a change to the width prop (shell resize) resizes the map", async () => {
    geocode.mockResolvedValue(null);
    const { rerender } = render(<MapCanvas requests={[]} onClose={() => {}} width={440} />);
    await waitFor(() => expect(mapInstances.length).toBe(1));
    mapInstances[0].resize.mockClear();
    // The shell owns the width now; a wider drawer threads a new width prop down.
    rerender(<MapCanvas requests={[]} onClose={() => {}} width={560} />);
    expect(mapInstances[0].resize).toHaveBeenCalled();
  });
});

describe("MapCanvas — lifecycle (StrictMode-safe)", () => {
  test("unmounting removes the map", async () => {
    geocode.mockResolvedValue(null);
    const { unmount } = render(<MapCanvas requests={[]} onClose={() => {}} />);
    await waitFor(() => expect(mapInstances.length).toBe(1));
    const map = mapInstances[0];
    unmount();
    expect(map.remove).toHaveBeenCalled();
  });

  test("StrictMode mount/cleanup/remount creates exactly one live map", async () => {
    geocode.mockResolvedValue(null);
    render(
      <StrictMode>
        <MapCanvas requests={[]} onClose={() => {}} />
      </StrictMode>,
    );
    // The first pass's async creation is cancelled before it constructs, so despite the
    // double-invoke exactly one map is ever built — no leaked second map.
    await waitFor(() => expect(mapInstances.length).toBe(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(mapInstances.length).toBe(1);
  });
});

describe("MapCanvas — request dedupe across rerenders", () => {
  test("an already-seen request is not geocoded again", async () => {
    geocode.mockResolvedValue(geo("Lisbon", "Lisbon, Portugal"));
    const { rerender } = render(<MapCanvas requests={["Lisbon"]} onClose={() => {}} />);
    await screen.findByRole("button", { name: /Lisbon/ });
    expect(geocode).toHaveBeenCalledTimes(1);
    // Re-render with the same request: the `seen` set suppresses a second lookup.
    rerender(<MapCanvas requests={["Lisbon"]} onClose={() => {}} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(geocode).toHaveBeenCalledTimes(1);
  });
});
