import {
	MeshBasicMaterial,
	Layers,
	GreaterDepth,
} from 'three';
import type { WebGLRenderer, Scene, PerspectiveCamera } from 'three';

// ── Layer constants ────────────────────────────────────────────────
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
		depthFunc: GreaterDepth,
		depthWrite: false, // don't corrupt depth buffer with silhouette depth
	});

	// Cached layer masks — avoid allocating Layers objects per frame
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

		// Disable autoClear — renderer.render() must NOT clear the screen color
		// that the EffectComposer just wrote
		renderer.autoClear = false;

		// Null out background — scene.background is rendered independently of
		// overrideMaterial and would paint over the composer's output
		scene.background = null;

		// Render to screen framebuffer
		renderer.setRenderTarget(null);

		// Clear depth only — preserve color from composer, reset depth to far (1.0)
		renderer.clearDepth();

		// Pass A: write occluder (gear) depth only — no color output
		camera.layers.mask = occluderLayers.mask;
		scene.overrideMaterial = depthOnlyMaterial;
		renderer.render(scene, camera);

		// Pass B: player silhouette — draws where player depth > gear depth in buffer
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
