import * as THREE from "three";

export const TOP_DOWN_SHADOW_LAYER = 1;
const SHADOW_MAP_SIZE = 1024;
const SHADOW_FRUSTUM_HALF = 16;
// Gears are ~2.5u apart vertically on average (difficulty bands verticalMin/Max: 1.4–3.0).
// We want shadows from gears directly above to cast onto gears below, even when the player
// is airborne (up to ~4u above a gear). Anchor the shadow camera to look down at a point
// below the player so the frustum covers a wider vertical range beneath.
const SHADOW_CAMERA_HEIGHT = 6;
// Look down at a point 3 units below player — shifts the frustum coverage downward
const SHADOW_CAMERA_LOOK_OFFSET = 3;
const SHADOW_NEAR = 0.1;
// With camera at player.y + 6 looking at player.y - 3, the frustum covers more range below.
// This allows gear-to-gear shadows to persist when the player jumps.
const SHADOW_FAR = 12;
const SHADOW_DARKNESS = 0.48;

export type TopDownShadowUniforms = {
  shadowMap: { value: THREE.DepthTexture };
  shadowVP: { value: THREE.Matrix4 };
  shadowMapSize: { value: THREE.Vector2 };
  shadowDarkness: { value: number };
};

const SHADOW_VERTEX_DECLARATION = [
  "varying vec3 vShadowWorldPos;",
].join("\n");

const SHADOW_VERTEX_BODY = [
  "vec4 shadowWorldPosition = modelMatrix * vec4(transformed, 1.0);",
  "vShadowWorldPos = shadowWorldPosition.xyz;",
].join("\n");

const SHADOW_FRAGMENT_DECLARATION = [
  "varying vec3 vShadowWorldPos;",
  "uniform sampler2D uTopDownShadowMap;",
  "uniform mat4 uTopDownShadowVP;",
  "uniform vec2 uTopDownShadowMapSize;",
  "uniform float uTopDownShadowDarkness;",
].join("\n");

const SHADOW_FRAGMENT_BODY = [
  "{",
  "  vec4 shadowClip = uTopDownShadowVP * vec4(vShadowWorldPos, 1.0);",
  "  vec3 shadowProj = shadowClip.xyz / shadowClip.w * 0.5 + 0.5;",
  "  if (shadowProj.z >= 0.0 && shadowProj.z <= 1.0) {",
  "    float borderFadeX = smoothstep(0.0, 0.05, shadowProj.x) * (1.0 - smoothstep(0.95, 1.0, shadowProj.x));",
  "    float borderFadeY = smoothstep(0.0, 0.05, shadowProj.y) * (1.0 - smoothstep(0.95, 1.0, shadowProj.y));",
  "    float edgeFade = borderFadeX * borderFadeY;",
  "    if (edgeFade > 0.0) {",
  "      vec2 texelSize = 1.0 / uTopDownShadowMapSize;",
  "      float shadow = 0.0;",
  "      float bias = 0.0025;",
  "      for (int sx = -1; sx <= 1; sx++) {",
  "        for (int sy = -1; sy <= 1; sy++) {",
  "          float depth = texture2D(uTopDownShadowMap, shadowProj.xy + vec2(float(sx), float(sy)) * texelSize).r;",
  "          shadow += shadowProj.z - bias > depth ? 1.0 : 0.0;",
  "        }",
  "      }",
  "      shadow /= 9.0;",
  "      float distanceFade = 1.0 - smoothstep(0.72, 1.0, shadowProj.z);",
  "      gl_FragColor.rgb *= 1.0 - shadow * edgeFade * uTopDownShadowDarkness * distanceFade;",
  "    }",
  "  }",
  "}",
].join("\n");

let nextShadowMaterialCacheKey = 0;

export class TopDownShadowSystem {
  public readonly uniforms: TopDownShadowUniforms;

  private readonly shadowCamera = new THREE.OrthographicCamera(
    -SHADOW_FRUSTUM_HALF,
    SHADOW_FRUSTUM_HALF,
    SHADOW_FRUSTUM_HALF,
    -SHADOW_FRUSTUM_HALF,
    SHADOW_NEAR,
    SHADOW_FAR,
  );
  private readonly shadowTarget = new THREE.WebGLRenderTarget(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
  });
  private readonly shadowVP = new THREE.Matrix4();
  private readonly shadowLookTarget = new THREE.Vector3();
  private readonly depthOnlyMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
  ) {
    this.shadowTarget.texture.generateMipmaps = false;
    this.shadowTarget.depthTexture = new THREE.DepthTexture(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, THREE.UnsignedIntType);
    this.shadowTarget.depthTexture.format = THREE.DepthFormat;
    this.depthOnlyMaterial.colorWrite = false;

    this.shadowCamera.layers.set(TOP_DOWN_SHADOW_LAYER);
    this.shadowCamera.up.set(0, 0, -1);
    this.shadowCamera.rotation.set(-Math.PI / 2, 0, Math.PI);
    this.shadowCamera.updateProjectionMatrix();

    this.uniforms = {
      shadowMap: { value: this.shadowTarget.depthTexture },
      shadowVP: { value: this.shadowVP },
      shadowMapSize: { value: new THREE.Vector2(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE) },
      shadowDarkness: { value: SHADOW_DARKNESS },
    };
  }

  update(playerPosition: THREE.Vector3) {
    this.shadowCamera.position.set(
      playerPosition.x,
      playerPosition.y + SHADOW_CAMERA_HEIGHT,
      playerPosition.z,
    );
    this.shadowLookTarget.set(
      playerPosition.x,
      playerPosition.y - SHADOW_CAMERA_LOOK_OFFSET,
      playerPosition.z,
    );
    this.shadowCamera.lookAt(this.shadowLookTarget);
    this.shadowCamera.updateMatrixWorld(true);
    this.shadowVP.multiplyMatrices(this.shadowCamera.projectionMatrix, this.shadowCamera.matrixWorldInverse);
  }

  render() {
    const previousRenderTarget = this.renderer.getRenderTarget();
    const previousOverrideMaterial = this.scene.overrideMaterial;

    this.scene.overrideMaterial = this.depthOnlyMaterial;
    this.renderer.setRenderTarget(this.shadowTarget);
    this.renderer.clear();
    this.renderer.render(this.scene, this.shadowCamera);
    this.renderer.setRenderTarget(previousRenderTarget);
    this.scene.overrideMaterial = previousOverrideMaterial;
  }
}

export function applyTopDownShadowToObject(
  object: THREE.Object3D,
  uniforms: TopDownShadowUniforms,
) {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }

    const materials = Array.isArray(child.material) ? child.material : [child.material];
    let canCast = false;
    for (const material of materials) {
      if (!shouldPatchMaterial(material)) {
        continue;
      }
      patchTopDownShadowMaterial(material, uniforms);
      if (!material.transparent && !child.userData.skipTopDownShadowCaster) {
        canCast = true;
      }
    }

    if (canCast) {
      child.layers.enable(TOP_DOWN_SHADOW_LAYER);
    }
  });
}

function shouldPatchMaterial(material: THREE.Material): material is THREE.MeshBasicMaterial | THREE.MeshStandardMaterial {
  if (!(material instanceof THREE.MeshBasicMaterial || material instanceof THREE.MeshStandardMaterial)) {
    return false;
  }
  if (material.transparent && material.opacity < 0.999) {
    return false;
  }
  return true;
}

function patchTopDownShadowMaterial(
  material: THREE.MeshBasicMaterial | THREE.MeshStandardMaterial,
  uniforms: TopDownShadowUniforms,
) {
  const userData = material.userData as Record<string, unknown>;
  if (userData.topDownShadowPatched) {
    return;
  }
  userData.topDownShadowPatched = true;

  const existingOnBeforeCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    existingOnBeforeCompile?.call(material, shader, renderer);

    shader.uniforms.uTopDownShadowMap = uniforms.shadowMap;
    shader.uniforms.uTopDownShadowVP = uniforms.shadowVP;
    shader.uniforms.uTopDownShadowMapSize = uniforms.shadowMapSize;
    shader.uniforms.uTopDownShadowDarkness = uniforms.shadowDarkness;

    shader.vertexShader = shader.vertexShader
      .replace(
        "void main() {",
        `${SHADOW_VERTEX_DECLARATION}\nvoid main() {`,
      )
      .replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>\n${SHADOW_VERTEX_BODY}`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "void main() {",
        `${SHADOW_FRAGMENT_DECLARATION}\nvoid main() {`,
      )
      .replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>\n${SHADOW_FRAGMENT_BODY}`,
      );
  };

  const cacheKeySuffix = `top-down-shadow-${nextShadowMaterialCacheKey++}`;
  const existingCacheKey = material.customProgramCacheKey;
  material.customProgramCacheKey = () => {
    const baseKey = existingCacheKey ? existingCacheKey.call(material) : "";
    return `${baseKey}:${cacheKeySuffix}`;
  };
  material.needsUpdate = true;
}
