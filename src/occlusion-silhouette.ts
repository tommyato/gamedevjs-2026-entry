import {
	MeshBasicMaterial,
	Layers,
	GreaterDepth,
} from 'three';
import type { WebGLRenderer, Scene, PerspectiveCamera, Group, Object3D } from 'three';

// ── Layer constants ────────────────────────────────────────────────
export const OCCLUDER_LAYER = 10;
export const SILHOUETTE_PLAYER_LAYER = 11;
export const SILHOUETTE_ACTIVE_GEAR_LAYER = 12;

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
		depthWrite: false,
	});

	const activeGearSilhouetteMaterial = new MeshBasicMaterial({
		color: 0x5a8a9a, // muted teal — subtler than player, reads as "gear outline"
		depthTest: true,
		depthFunc: GreaterDepth,
		depthWrite: false,
	});

	// Cached layer masks — avoid allocating Layers objects per frame
	const occluderLayers = new Layers();
	occluderLayers.set(OCCLUDER_LAYER);

	const playerSilhouetteLayers = new Layers();
	playerSilhouetteLayers.set(SILHOUETTE_PLAYER_LAYER);

	const activeGearSilhouetteLayers = new Layers();
	activeGearSilhouetteLayers.set(SILHOUETTE_ACTIVE_GEAR_LAYER);

	// The gear the player is currently standing on — set each frame by the game
	let activeGearMesh: Group | null = null;

	function setActiveGear(gearMesh: Group | null) {
		// Disable silhouette layer on previous gear
		if (activeGearMesh && activeGearMesh !== gearMesh) {
			activeGearMesh.traverse((child: Object3D) => {
				if ((child as any).isMesh) {
					child.layers.disable(SILHOUETTE_ACTIVE_GEAR_LAYER);
				}
			});
		}
		// Enable silhouette layer on new gear
		if (gearMesh && gearMesh !== activeGearMesh) {
			gearMesh.traverse((child: Object3D) => {
				if ((child as any).isMesh) {
					child.layers.enable(SILHOUETTE_ACTIVE_GEAR_LAYER);
				}
			});
		}
		activeGearMesh = gearMesh;
	}

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

		// Temporarily remove active gear from occluder set so its own depth
		// doesn't block its silhouette pass
		if (activeGearMesh) {
			activeGearMesh.traverse((child: Object3D) => {
				if ((child as any).isMesh) child.layers.disable(OCCLUDER_LAYER);
			});
		}

		// Pass A: write occluder depth (all gears EXCEPT the active one)
		camera.layers.mask = occluderLayers.mask;
		scene.overrideMaterial = depthOnlyMaterial;
		renderer.render(scene, camera);

		// Pass B: player silhouette — behind other gears (not the one they're on)
		camera.layers.mask = playerSilhouetteLayers.mask;
		scene.overrideMaterial = playerSilhouetteMaterial;
		renderer.render(scene, camera);

		// Pass C: active gear silhouette — shows where the player's gear is
		// occluded by other gears above/in front
		if (activeGearMesh) {
			camera.layers.mask = activeGearSilhouetteLayers.mask;
			scene.overrideMaterial = activeGearSilhouetteMaterial;
			renderer.render(scene, camera);
		}

		// Restore occluder layer on active gear
		if (activeGearMesh) {
			activeGearMesh.traverse((child: Object3D) => {
				if ((child as any).isMesh) child.layers.enable(OCCLUDER_LAYER);
			});
		}

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
		activeGearSilhouetteMaterial.dispose();
	}

	return { render, dispose, setActiveGear };
}
