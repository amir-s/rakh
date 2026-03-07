import { CSSProperties, useEffect, useRef } from "react";

type IconShaderEffectProps = {
  /**
   * URL or path of the image to render in the shader.
   * Example: "/icon.png" or a CDN URL.
   */
  src: string;

  /**
   * Class applied to the outer container div.
   */
  className?: string;

  /**
   * Inline styles applied to the outer container div.
   */
  style?: CSSProperties;

  /**
   * Class applied directly to the canvas element.
   */
  canvasClassName?: string;

  /**
   * Strength of the cursor-driven surface distortion.
   * Higher = more liquid / wavy movement.
   *
   * Range: 0 → 3
   * Recommended: 1.2 – 1.8
   */
  warpStrength?: number;

  /**
   * Strength of the chromatic aberration (RGB splitting).
   * Higher = more cyber / glitch / refractive look.
   *
   * Range: 0 → 3
   * Recommended: 0.8 – 1.5
   */
  aberrationStrength?: number;

  /**
   * Intensity of the glow around the cursor.
   * Controls the light bloom following the mouse.
   *
   * Range: 0 → 3
   * Recommended: 1.2 – 1.8
   */
  glowStrength?: number;

  /**
   * Edge lighting enhancement based on texture gradients.
   * Makes folds / edges pop with a subtle highlight.
   *
   * Range: 0 → 3
   * Recommended: 1.0 – 1.4
   */
  edgeStrength?: number;

  /**
   * Animated shimmer that runs across the surface.
   * Gives a glossy / reflective animated feel.
   *
   * Range: 0 → 3
   * Recommended: 0.4 – 1.0
   */
  shimmerStrength?: number;

  /**
   * Micro-noise distortion added to the warp.
   * Higher = more chaotic / organic movement.
   *
   * Range: 0 → 2
   * Recommended: 0.1 – 0.6
   */
  noiseStrength?: number;

  /**
   * Speed at which hover effects appear/disappear.
   * Lower = smoother, slower transition.
   *
   * Range: 0.01 → 0.2
   * Recommended: 0.06 – 0.12
   */
  hoverEase?: number;

  /**
   * Mouse smoothing factor.
   * Lower = smoother lag behind cursor.
   * Higher = more responsive.
   *
   * Range: 0.02 → 0.2
   * Recommended: 0.06 – 0.12
   */
  mouseEase?: number;

  /**
   * Maximum device pixel ratio used for rendering.
   * Prevents insane GPU usage on retina displays.
   *
   * Range: 1 → 3
   * Recommended: 2
   */
  maxDpr?: number;

  /**
   * Border radius applied to the canvas container.
   * Accepts number (px) or CSS value.
   *
   * Example:
   * 32
   * "20px"
   * "2rem"
   */
  borderRadius?: number | string;

  /**
   * Callback fired when the image texture is loaded.
   */
  onLoad?: () => void;

  /**
   * Callback fired if the image fails to load
   * or if WebGL fails.
   */
  onError?: (error: Error) => void;
};

const vertexShaderSource = `
attribute vec2 a_position;
attribute vec2 a_uv;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const fragmentShaderSource = `
precision mediump float;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform float u_time;
uniform float u_hover;
uniform float u_warpStrength;
uniform float u_aberrationStrength;
uniform float u_glowStrength;
uniform float u_edgeStrength;
uniform float u_shimmerStrength;
uniform float u_noiseStrength;

varying vec2 v_uv;

float circle(vec2 uv, vec2 center, float radius, float blur) {
  float d = length(uv - center);
  return smoothstep(radius + blur, radius - blur, d);
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);

  return mix(
    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

void main() {
  vec2 uv = v_uv;
  vec2 mouse = u_mouse;

  float dist = distance(uv, mouse);
  float influence = exp(-dist * 8.0) * u_hover;

  vec2 dir = uv - mouse;
  float ripple = sin(dist * 34.0 - u_time * 3.6) * 0.0065 * influence * u_warpStrength;
  vec2 warp = normalize(dir + 0.0001) * ripple;

  warp += vec2(
    sin((uv.y + u_time * 0.14) * 11.0),
    cos((uv.x - u_time * 0.16) * 11.0)
  ) * 0.0035 * u_hover * u_warpStrength;

  float grain = noise(uv * 8.0 + vec2(u_time * 0.12, -u_time * 0.08));
  warp += (grain - 0.5) * 0.01 * influence * u_noiseStrength;

  vec2 sampleUv = uv + warp;

  float aberration = 0.010 * influence * u_aberrationStrength;
  vec4 cr = texture2D(u_image, sampleUv + vec2(aberration, 0.0));
  vec4 cg = texture2D(u_image, sampleUv);
  vec4 cb = texture2D(u_image, sampleUv - vec2(aberration, 0.0));
  vec4 base = vec4(cr.r, cg.g, cb.b, cg.a);

  float glow = circle(uv, mouse, 0.16, 0.34) * 0.34 * u_hover * u_glowStrength;
  vec3 glowColor = vec3(0.35, 0.55, 1.0) * glow;

  vec2 sweepDir = normalize(vec2(1.0, -0.7));
  float sweep = dot(uv - mouse, sweepDir);
  float sweepBand = exp(-abs(sweep) * 18.0) * 0.18 * influence * u_glowStrength;
  vec3 sweepColor = vec3(0.55, 0.75, 1.0) * sweepBand;

  float shimmer = sin((uv.x + uv.y) * 18.0 - u_time * 2.2) * 0.5 + 0.5;
  float shimmerMask = smoothstep(0.15, 0.95, base.a) * influence * u_shimmerStrength;
  vec3 shimmerColor = vec3(0.45, 0.52, 1.0) * shimmer * 0.14 * shimmerMask;

  vec2 texel = 1.0 / u_resolution;
  vec3 s1 = texture2D(u_image, sampleUv + vec2(texel.x * 2.0, 0.0)).rgb;
  vec3 s2 = texture2D(u_image, sampleUv - vec2(texel.x * 2.0, 0.0)).rgb;
  vec3 s3 = texture2D(u_image, sampleUv + vec2(0.0, texel.y * 2.0)).rgb;
  vec3 s4 = texture2D(u_image, sampleUv - vec2(0.0, texel.y * 2.0)).rgb;
  float edge = length((s1 - s2) + (s3 - s4));
  vec3 edgeTint = mix(vec3(0.0), vec3(0.55, 0.72, 1.0), smoothstep(0.08, 0.45, edge)) * 0.28 * u_edgeStrength;

  vec3 color = base.rgb + glowColor + sweepColor + shimmerColor + edgeTint * u_hover;
  color += (grain - 0.5) * 0.04 * u_noiseStrength * influence;

  gl_FragColor = vec4(color, base.a);
}
`;

function createShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) || "Unknown shader compile error";
    gl.deleteShader(shader);
    throw new Error(info);
  }
  return shader;
}

function createProgram(
  gl: WebGLRenderingContext,
  vsSource: string,
  fsSource: string,
) {
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  if (!program) throw new Error("Could not create program");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) || "Unknown program link error";
    gl.deleteProgram(program);
    throw new Error(info);
  }
  return program;
}

export default function IconShaderEffect({
  src,
  className,
  style,
  canvasClassName,
  warpStrength = 1.35,
  aberrationStrength = 1.35,
  glowStrength = 1.4,
  edgeStrength = 1.25,
  shimmerStrength = 0.9,
  noiseStrength = 0.45,
  hoverEase = 0.08,
  mouseEase = 0.08,
  maxDpr = 2,
  borderRadius = 32,
  onLoad,
  onError,
}: IconShaderEffectProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef({
    warpStrength,
    aberrationStrength,
    glowStrength,
    edgeStrength,
    shimmerStrength,
    noiseStrength,
    hoverEase,
    mouseEase,
    maxDpr,
  });

  propsRef.current = {
    warpStrength,
    aberrationStrength,
    glowStrength,
    edgeStrength,
    shimmerStrength,
    noiseStrength,
    hoverEase,
    mouseEase,
    maxDpr,
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", {
      premultipliedAlpha: true,
      alpha: true,
    })!;
    if (!gl) {
      onError?.(new Error("WebGL is not supported in this browser."));
      return;
    }

    let animationFrame = 0;
    let destroyed = false;
    let textureLoaded = false;

    const mouse = { x: 0.5, y: 0.5 };
    const targetMouse = { x: 0.5, y: 0.5 };
    let hover = 0;
    let targetHover = 0;
    const start = performance.now();

    let program: WebGLProgram;

    try {
      program = createProgram(gl, vertexShaderSource, fragmentShaderSource);
    } catch (error) {
      onError?.(
        error instanceof Error
          ? error
          : new Error("Failed to compile shader program."),
      );
      return;
    }

    gl.useProgram(program);

    const positionLoc = gl.getAttribLocation(program, "a_position");
    const uvLoc = gl.getAttribLocation(program, "a_uv");
    const resolutionLoc = gl.getUniformLocation(program, "u_resolution");
    const mouseLoc = gl.getUniformLocation(program, "u_mouse");
    const timeLoc = gl.getUniformLocation(program, "u_time");
    const hoverLoc = gl.getUniformLocation(program, "u_hover");
    const imageLoc = gl.getUniformLocation(program, "u_image");
    const warpStrengthLoc = gl.getUniformLocation(program, "u_warpStrength");
    const aberrationStrengthLoc = gl.getUniformLocation(
      program,
      "u_aberrationStrength",
    );
    const glowStrengthLoc = gl.getUniformLocation(program, "u_glowStrength");
    const edgeStrengthLoc = gl.getUniformLocation(program, "u_edgeStrength");
    const shimmerStrengthLoc = gl.getUniformLocation(
      program,
      "u_shimmerStrength",
    );
    const noiseStrengthLoc = gl.getUniformLocation(program, "u_noiseStrength");

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, -1, 1, 0, 0, 1, -1, 1, 1, 1, 1,
        1, 0,
      ]),
      gl.STATIC_DRAW,
    );

    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);

    const texture = gl.createTexture();
    if (!texture) {
      onError?.(new Error("Could not create texture."));
      return;
    }

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const img = new Image();
    img.crossOrigin = "anonymous";

    function resize() {
      const dpr = Math.min(
        window.devicePixelRatio || 1,
        propsRef.current.maxDpr,
      );
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    function render(now: number) {
      if (destroyed || !textureLoaded) return;

      const t = (now - start) * 0.001;
      mouse.x += (targetMouse.x - mouse.x) * propsRef.current.mouseEase;
      mouse.y += (targetMouse.y - mouse.y) * propsRef.current.mouseEase;
      hover += (targetHover - hover) * propsRef.current.hoverEase;

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.uniform2f(resolutionLoc, canvas.width, canvas.height);
      gl.uniform2f(mouseLoc, mouse.x, mouse.y);
      gl.uniform1f(timeLoc, t);
      gl.uniform1f(hoverLoc, hover);
      gl.uniform1f(warpStrengthLoc, propsRef.current.warpStrength);
      gl.uniform1f(aberrationStrengthLoc, propsRef.current.aberrationStrength);
      gl.uniform1f(glowStrengthLoc, propsRef.current.glowStrength);
      gl.uniform1f(edgeStrengthLoc, propsRef.current.edgeStrength);
      gl.uniform1f(shimmerStrengthLoc, propsRef.current.shimmerStrength);
      gl.uniform1f(noiseStrengthLoc, propsRef.current.noiseStrength);
      gl.uniform1i(imageLoc, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      animationFrame = requestAnimationFrame(render);
    }

    function handleMove(e: MouseEvent) {
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      targetMouse.x = Math.max(0, Math.min(1, x));
      targetMouse.y = Math.max(0, Math.min(1, y));
    }

    function handleEnter() {
      targetHover = 1;
    }

    function handleLeave() {
      targetHover = 0;
    }

    img.onload = () => {
      if (destroyed) return;
      textureLoaded = true;
      resize();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      onLoad?.();
      animationFrame = requestAnimationFrame(render);
    };

    img.onerror = () => {
      onError?.(new Error(`Failed to load image: ${src}`));
    };

    img.src = src;

    window.addEventListener("resize", resize);
    canvas.addEventListener("mousemove", handleMove);
    canvas.addEventListener("mouseenter", handleEnter);
    canvas.addEventListener("mouseleave", handleLeave);

    return () => {
      destroyed = true;
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("mousemove", handleMove);
      canvas.removeEventListener("mouseenter", handleEnter);
      canvas.removeEventListener("mouseleave", handleLeave);
      if (buffer) gl.deleteBuffer(buffer);
      if (texture) gl.deleteTexture(texture);
      gl.deleteProgram(program);
    };
  }, [src, onError, onLoad]);

  return (
    <div
      className={className}
      style={{
        position: "relative",
        overflow: "hidden",
        width: "100%",
        height: "100%",
        borderRadius,
        ...style,
      }}
    >
      <canvas
        ref={canvasRef}
        className={canvasClassName}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          borderRadius: "inherit",
        }}
      />
    </div>
  );
}

export function DemoIconShaderEffect() {
  return (
    <div style={{ width: 400, aspectRatio: "1 / 1" }}>
      <IconShaderEffect
        src="https://i.postimg.cc/NjL9kqhy/icon.png"
        warpStrength={0}
        aberrationStrength={3}
        glowStrength={2}
        edgeStrength={1}
        shimmerStrength={3}
        noiseStrength={0.45}
      />
    </div>
  );
}
