import {
	MeshBasicMaterial,
	Layers,
	GreaterDepth,
} from "three";
import type { WebGLRenderer, Scene, PerspectiveCamera } from "three";

// ── Layer constants ────────────────────────────────────────────────
// Center pole AND gears both flag OCCLUDER_LAYER. The orbit camera nudges
// itself to clear gear overlap, but during the lerp (and behind the pole)
// the player can disappear for several frames — the silhouette pass paints
// a bronze cutout of the avatar wherever depth says it's hidden.
export const OCCLUDER_LAYER = 10;
export const SILHOUETTE_PLAYER_LAYER = 11;

export function createOcclusionSilhouette(
	renderer: WebGLRenderer,
	scene: Scene,
	camera: PerspectiveCamera,
) {
	// Pre-allocated materials — zero per-frame allocation
	const depthOnlyMaterial = new MeshBasicMaterial({
		colorWrite: false, // no color output — depth write only
	});

	const playerSilhouetteMaterial = new MeshBasicMaterial({
		color: 0xcd7f32, // bronze/gold — clearly the player
		depthTest: true,
		depthFunc: GreaterDepth, // only draw where the player is BEHIND an occluder
		depthWrite: false,
	});

	// Cached layer masks
	const occluderLayers = new Layers();
	occluderLayers.set(OCCLUDER_LAYER);

	const playerSilhouetteLayers = new Layers();
	playerSilhouetteLayers.set(SILHOUETTE_PLAYER_LAYER);

	function render() {
		const savedLayers = camera.layers.mask;
		const savedOverride = scene.overrideMaterial;
		const savedBackground = scene.background;
		const savedRT = renderer.getRenderTarget();
		const savedAutoClear = renderer.autoClear;

		renderer.autoClear = false;
		scene.background = null;
		renderer.setRenderTarget(null);

		// Clear depth only — preserve color from composer, reset depth to far (1.0)
		renderer.clearDepth();

		// Pass A: write occluder depth (center pole + all gears)
		camera.layers.mask = occluderLayers.mask;
		scene.overrideMaterial = depthOnlyMaterial;
		renderer.render(scene, camera);

		// Pass B: player silhouette — bronze where the player is behind any occluder
		camera.layers.mask = playerSilhouetteLayers.mask;
		scene.overrideMaterial = playerSilhouetteMaterial;
		renderer.render(scene, camera);

		// Restore all state
		scene.overrideMaterial = savedOverride;
		scene.background = savedBackground;
		camera.layers.mask = savedLayers;
		renderer.setRenderTarget(savedRT);
		renderer.autoClear = savedAutoClear;
	}

	function dispose() {
		depthOnlyMaterial.dispose();
		playerSilhouetteMaterial.dispose();
	}

	return { render, dispose };
}
