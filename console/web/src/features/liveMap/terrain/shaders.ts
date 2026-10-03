// GLSL for the Deep Desert terrain renderer, extracted mechanically from the
// offline prototype at `.claude/deep-desert-terrain/`. Every constant here was
// calibrated against the game's own material parameters, so edit with care and
// prefer re-extracting over retyping.
//
// It differs from the prototype in exactly two places, both deliberate: the
// boundary clip applies to rock as well, and the backdrop plane is the rock
// tone. A pixel diff against the prototype should therefore differ at the map
// boundary and on the backdrop, and nowhere else.


// Terrain vertex shader. Two paths: a height-field grid driven purely by
// gl_VertexID, and instanced meshes for rock / patches / POIs.
export const VS = `#version 300 es
precision highp float;
layout(location=0) in uvec3 aPos;
layout(location=1) in vec2 aNrm;
layout(location=2) in vec3 iC0;
layout(location=3) in vec3 iC1;
layout(location=4) in vec3 iC2;
layout(location=5) in vec3 iT;
layout(location=6) in float iMat;
layout(location=7) in float iLift;   // world uu this instance rises by, if buried
layout(location=8) in vec2 aUV;      // textured rock only; a constant zero elsewhere
uniform vec3 uLo, uExt;
uniform mat4 uVP;
// uFeather: width (world uu) of the band at a tile's rim over which its
// contribution fades out. Landscape tiles overlap their neighbours by ~992 uu,
// so fading across that band cross-dissolves the two surfaces instead of
// letting the depth test pick one and cut a hard crease.
// The weight is evaluated per fragment, not per vertex: these tiles carry only
// ~500 vertices each, so a per-vertex weight would be interpolated across
// 10,000 uu triangles and smear the band ten times wider than the overlap.
uniform float uFeather, uWScale, uBias, uLift;
// Rock marked as hanging in the air (iMat 0.25) has its skirts, the vertices
// from uSkirtFrom on, carried down to uFootZ.
uniform int uSkirtFrom;
uniform float uFootZ;
// The landscape can be drawn either as the game's overlapping tiles or as one
// continuous height field resampled from them. The field has no tile borders,
// so it has neither seams nor tears, and its normal comes from central
// differences on the grid, which is continuous by construction.
uniform highp usampler2D uHF;   // integer samplers have no default precision
uniform float uHFMode, uHN, uHStep, uHX0, uHY0, uHZlo, uHZhi;
// Tilted only: how far the height field's outermost ring is pushed out.
uniform float uApron;
float hfAt(ivec2 p){
  ivec2 q = clamp(p, ivec2(0), ivec2(int(uHN)-1));
  return uHZlo + float(texelFetch(uHF,q,0).r)/65535.0*(uHZhi-uHZlo);
}
out vec3 vN; out float vZ; out float vMat; out vec2 vXY;
flat out vec4 vBox; out float vWS; out float vEdge; flat out float vClip;
flat out float vRand;
out vec2 vUV;
// For texturing a cliff from the side: how much the face looks along the mesh's
// x and y, and its height as a texture coordinate at the density u and v have.
out vec2 vSideW; out vec2 vSideUV;
// A per-instance random hashed from the instance's translation: no attribute, no
// bytes. iT reaches ~1e6 uu, so it is scaled down to keep the hash meaningful.
float hash13(vec3 p){
  vec3 q = fract(p * 0.0013);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
vec3 octDec(vec2 e){
  vec3 n=vec3(e.xy, 1.0-abs(e.x)-abs(e.y));
  if(n.z<0.0){ n.xy=(1.0-abs(n.yx))*vec2(n.x>=0.0?1.0:-1.0, n.y>=0.0?1.0:-1.0); }
  return normalize(n);
}
void main(){
  if(uHFMode > 0.5){
    int n = int(uHN);
    int ix = gl_VertexID % n, iy = gl_VertexID / n;
    float h = hfAt(ivec2(ix,iy));
    vec3 wf = vec3(uHX0 + float(ix)*uHStep, uHY0 + float(iy)*uHStep, h);
    float dx = hfAt(ivec2(ix+1,iy)) - hfAt(ivec2(ix-1,iy));
    float dy = hfAt(ivec2(ix,iy+1)) - hfAt(ivec2(ix,iy-1));
    vN = normalize(vec3(-dx, -dy, 2.0*uHStep));
    // Carry the sand on as a plain under the rock that stands past it. The
    // field's two outer rings ship level with each other, so stretching the
    // last one smears no dunes across the plain.
    if(uApron > 0.0){
      wf.x += ix==0 ? -uApron : (ix==n-1 ? uApron : 0.0);
      wf.y += iy==0 ? -uApron : (iy==n-1 ? uApron : 0.0);
    }
    vRand = 0.5;   // neutral: the height field has no instances
    vUV = vec2(0.0); vSideW = vec2(0.0); vSideUV = vec2(0.5);
    vZ = wf.z; vMat = 1.0; vXY = wf.xy; vBox = vec4(0.0); vWS = 1.0; vEdge = 1e9; vClip = -1e9;
    gl_Position = uVP*vec4(wf,1.0);
    gl_Position.z += uBias;
    return;
  }
  vec3 p = uLo + (vec3(aPos)/65535.0)*uExt;
  mat3 R = mat3(iC0,iC1,iC2);
  vec3 w = R*p + iT;
  w.z += ((iMat > 1.5 && iMat < 2.5) ? 0.0 : iLift*uLift);   // patches use iLift as a clip height
  // Only skirt bottoms move, straight down: every open edge gets a wall to the
  // ground, and seen from above nothing changes.
  if(iMat > 0.2 && iMat < 0.3 && gl_VertexID >= uSkirtFrom) w.z = min(w.z, uFootZ);
  vClip = iLift;
  vN = normalize(R*octDec(aNrm));
  vRand = hash13(iT);
  vUV = aUV;
  vec3 nl = octDec(aNrm);
  vSideW = abs(nl.xy);
  // Height from the finished vertex, so a skirt carried to the ground keeps the texture's scale.
  vSideUV = 0.5 + ((w.z - iT.z)/length(iC2) - (uLo.z + 0.5*uExt.z)) / uExt.xy;
  vZ = w.z; vMat = iMat; vXY = w.xy;
  vec2 e0 = (R*vec3(uLo.xy,0.0)).xy + iT.xy;
  vec2 e1 = (R*vec3(uLo.xy+uExt.xy,0.0)).xy + iT.xy;
  vBox = vec4(min(e0,e1), max(e0,e1));   // this instance's footprint, in world
  vWS  = uWScale;
  vec2 hi2 = uLo.xy + uExt.xy;
  vEdge = min(min(p.x-uLo.x, hi2.x-p.x), min(p.y-uLo.y, hi2.y-p.y)) * length(iC0);
  gl_Position = uVP * vec4(w,1.0);
  gl_Position.z += uBias;   // depth pre-pass pushes back so both tiles blend
}`;

// Terrain fragment shader. Three materials, world-space sand detail, and the
// patch clip that gives a buried landmark an organic outline.
export const FS = `#version 300 es
precision highp float;
in vec3 vN; in float vZ; in float vMat; in vec2 vXY;
flat in vec4 vBox; in float vWS; in float vEdge; flat in float vClip;
flat in float vRand;
in vec2 vUV;
in vec2 vSideW; in vec2 vSideUV;
// The baked diffuse of each rock family's in-world counterpart, one layer each.
uniform mediump sampler2DArray uRock;
uniform float uTexOn, uTexLayer, uTexGain;
// TEXTINT brings textured rock up to the untextured rock's brightness; TEXKNEE
// starts a highlight shoulder so lit tops roll off instead of clipping.
#define TEXTINT 1.37
#define TEXKNEE 0.7
// TEXHUE pulls textured rock toward the map's ochre (0 = the game's colour,
// 1 = the map's), so families whose shape differs from the map's blend in.
#define TEXHUE 0.5
// Per-instance rock tone spread, +/- this fraction.
#define ROCKVAR 0.25
uniform float uFeather;
uniform sampler2D uD1, uD2, uBrk;
uniform float uTile, uDetStr, uDetail;
uniform float uBrkTile, uBrkAmp, uClipRaise;
uniform vec3 uV, uPatchCol, uPoiCol;
// 0 top-down, 1 once tilted: how far rock has eased to the tilted lighting.
uniform float uSideLit;
// the height field again, so a terrain patch can hide the skirt it buries
uniform highp usampler2D uHF;
uniform float uHN, uHStep, uHX0, uHY0, uHZlo, uHZhi, uPatchCut, uPatchFeather, uPrepass;
// Pick pass: write the fragment's world height instead of a colour.
uniform float uPick;
float hfTexel(ivec2 p){
  ivec2 q = clamp(p, ivec2(0), ivec2(int(uHN)-1));
  return uHZlo + float(texelFetch(uHF,q,0).r)/65535.0*(uHZhi-uHZlo);
}
uniform vec3 uL; uniform float uZlo, uZhi;
uniform vec2 uC; uniform float uHalf;
// Elevation lines: on/off weight, and the banding intervals for rock and sand.
uniform float uCon, uConStep, uConStepS;
// Sector grid: min corner, cell size and cell count (0 = off); line width in buffer pixels.
uniform vec4 uGrid; uniform float uGridPx;
out vec4 o;
void main(){
  // Hard-clip everything to the square so the mapped area has a crisp edge.
  //
  // Rock used to be exempt here, because slicing a cliff per-fragment exposes
  // its hollow interior with the sand behind showing through. That reasoning
  // holds for a cut INSIDE the map; at the boundary there is nothing behind the
  // cut but the backdrop, and the exemption instead let the southern shield wall
  // spill unbounded past the map edge. Checked at 234 uu/px: the cut face is
  // clean, no interior is exposed.
  //
  // Tilted, uHalf is widened to take in the wall past the edge.
  if(abs(vXY.x-uC.x)>uHalf || abs(vXY.y-uC.y)>uHalf) discard;
  // A terrain patch is composited over the landscape, which exposes the deep
  // flat skirt it is meant to bury -- 74% of this mesh sits over 1000 uu under
  // the sand. Drop those fragments so the raised part keeps an organic outline
  // instead of showing the mesh's full quad footprint.
  float pfade = 1.0;
  if(vMat > 1.5 && vMat < 2.5){
    // Two fades. Toward the mesh's own footprint edge, so the quad rim
    // dissolves instead of breaking the sand as a sawtooth -- that sawtooth was
    // the only thing capping how far a patch could be raised. And downward,
    // hiding whatever still sits well under the sand.
    pfade = smoothstep(0.0, uPatchFeather, vEdge);
    // The game's material is BLEND_Masked with no UVs and no vertex colours, so
    // its mask is procedural from world position -- and its outline is a smooth
    // closed curve, which is what clipping a terraced mesh at a constant height
    // gives. Clipping against the sand SURFACE instead drags the dune ripples
    // into the boundary and makes it ragged. vClip is that flat height.
    // The clip has to sit above the sand line, or the depth test against the
    // sand owns the boundary and the mask -- breakup included -- does nothing.
    float clip = vClip + uClipRaise;
    if(uBrkAmp > 0.0){
      vec2 qb = vec2(vXY.x, -vXY.y)/uBrkTile;
      clip += (texture(uBrk, qb).r - 0.5)*2.0*uBrkAmp;
    }
    pfade *= smoothstep(clip - uPatchCut, clip + uPatchCut, vZ);
    if(pfade <= 0.002) discard;
    // Where the patch is fading it must NOT own the depth, or the sand behind
    // it is rejected and the fade reveals the backdrop instead of the ground.
    if(uPrepass > 0.5 && pfade < 0.999) discard;
  }
  // Picking also enables prepass for the same visibility mask, but must write
  // the height and hit flag before the depth-only pass's early return.
  if(uPick > 0.5){ o = vec4(vZ, 1.0, 0.0, 1.0); return; }
  // The depth pass writes no colour: everything that can discard has run, so stop here.
  if(uPrepass > 0.5){ o = vec4(0.0); return; }
  vec3 n = normalize(vN); if(n.z<0.0) n=-n;
  // Sand detail. The map's own material carries no mesh UVs, so it tiles these
  // dune normal maps in world space; we do the same, at the game's own period
  // and strength. Two layers at different scales and a rotation stand in for
  // the material's stochastic tiling, which hides the repeat.
  if(uDetail>0.0 && vMat>0.5 && vMat<1.5){
    vec2 q = vec2(vXY.x, -vXY.y);
    vec2 a = texture(uD1, q/uTile).xy*2.0-1.0;
    mat2 rot = mat2(0.8,-0.6, 0.6,0.8);
    vec2 b2 = texture(uD2, (rot*q)/(uTile*1.37) + vec2(0.37,0.11)).xy*2.0-1.0;
    n = normalize(vec3(n.xy + (a+b2)*uDetStr*uDetail, n.z));
  }
  float t = clamp((vZ-uZlo)/max(uZhi-uZlo,1.0),0.0,1.0);
  vec3 sand = mix(vec3(0.804,0.631,0.443), vec3(0.980,0.914,0.769), t);
  // Per-instance tone: brightness plus a slight warm/cool swing, since brightness
  // alone reads as lighting. The game's own material does the same.
  float rv = vRand - 0.5;
  vec3 rock = vec3(0.588,0.416,0.173)*(0.88+0.45*t)
            * (1.0 + rv*2.0*ROCKVAR)
            * vec3(1.0 + rv*ROCKVAR*0.5, 1.0, 1.0 - rv*ROCKVAR*0.5);
  // 0 = rock, 1 = sand, 2 = terrain patch. The patch colour is the game's own
  // MI_UIMap_Terrain_3 tint (#CCAE7A) -- drawing these as rock made a large
  // ground patch read as a dark slab.
  vec3 alb  = mix(rock, sand, step(0.5, vMat));
  bool textured = uTexOn > 0.5 && vMat < 0.5;
  if(textured){
    vec3 tx = texture(uRock, vec3(vUV, uTexLayer)).rgb;
    // The texture is laid on from overhead, so down a cliff it smears into
    // vertical stripes. Tilted, a steep face takes it from the side instead:
    // across the face one way, up the face the other.
    if(uSideLit > 0.0){
      vec2 s = vSideW*vSideW; s *= s;
      float up = max(1.0 - dot(vSideW, vSideW), 0.0); up *= up;
      if(s.x + s.y > 0.02*up){
        vec3 sx = texture(uRock, vec3(vSideUV.y, vUV.y, uTexLayer)).rgb;
        vec3 sy = texture(uRock, vec3(vUV.x, vSideUV.x, uTexLayer)).rgb;
        tx = mix(tx, (tx*up + sx*s.x + sy*s.y) / (up + s.x + s.y), uSideLit);
      }
    }
    tx *= uTexGain;
    // the texture's light and dark, over its family's normalised mean luminance (0.414)
    float tl = dot(tx, vec3(0.2126, 0.7152, 0.0722)) / 0.414;
    alb = mix(tx * TEXTINT, rock * tl, TEXHUE);
  }
  alb = mix(alb, uPatchCol, step(1.5, vMat));
  alb = mix(alb, uPoiCol,   step(2.5, vMat));   // POIs: the map's own #89A897
  float lam = clamp(dot(n,uL),0.0,1.0);
  float flat_ = uL.z;
  float rel = (lam-flat_)/max(1.0-flat_,1e-3);
  float sh = clamp(1.0+0.55*rel, 0.30, 1.75);
  // That curve is built for looking straight down and bottoms out 60 degrees off
  // the sun. Tilted, cliff faces turn toward the camera, all at that floor, and
  // read as holes. So rock and POIs ease to ambient + plain sun + a fill from the
  // camera; flat ground stays near 1.0 either way.
  if(uSideLit > 0.0 && (vMat < 0.5 || vMat > 2.5)){
    float sun  = lam / max(flat_, 1e-3);
    float fill = clamp(dot(n, uV), 0.0, 1.0);
    sh = mix(sh, 0.35 + 0.45*sun + 0.35*fill, uSideLit);
  }
  vec3 lit = alb*sh;
  if(textured){
    vec3 over = max(lit - TEXKNEE, 0.0);
    lit = min(lit, vec3(TEXKNEE)) + (1.0 - TEXKNEE) * (1.0 - exp(-over / (1.0 - TEXKNEE)));
  }
  vec3 c = pow(clamp(lit,0.0,1.0), vec3(1.0/1.02));
  // Elevation lines. Not true isolines: the rock is terraced, and across a flat
  // tread an isoline vanishes. Banding the height and marking where the band
  // index changes catches the tread boundaries instead.
  if(uCon > 0.0){
    if(vMat < 0.5){
      // Rock: not density-faded, since the steepest edges are the ones to keep.
      float b    = floor(vZ / uConStep);
      float edge = clamp(fwidth(b), 0.0, 1.0);
      float tone = 1.0 - 0.045*mod(b, 2.0);
      c *= tone * mix(1.0, 0.72, edge*uCon);
    } else if(vMat < 1.5){
      // Sand: faded where a dune flank crosses many bands per pixel. The window
      // is wide on purpose; a tight one made the lines dashed.
      float bs   = floor(vZ / uConStepS);
      float edge = clamp(fwidth(bs), 0.0, 1.0);
      float dens = fwidth(vZ) / uConStepS;
      float fade = 1.0 - smoothstep(0.75, 1.60, dens);
      c *= mix(1.0, 0.82, edge*fade*uCon);
    }
  }
  // Sector grid, tilted only. Drawn on whatever surface is here, so it runs over
  // rock and down cliffs, and whatever stands in front hides it. Widths are in
  // screen pixels, from how fast the grid coordinate changes across the pixel.
  if(uGrid.w > 0.0){
    vec2 g = (vXY - uGrid.xy) / uGrid.z;
    vec2 fw = max(fwidth(g), vec2(1e-6));
    vec2 k = clamp(floor(g + 0.5), 0.0, uGrid.w);
    vec2 edge = vec2(k.x == 0.0 || k.x == uGrid.w, k.y == 0.0 || k.y == uGrid.w);
    vec2 halfW = uGridPx * mix(vec2(0.5), vec2(1.0), edge);
    vec2 cov = 1.0 - smoothstep(halfW - 0.5, halfW + 0.5, abs(g - k) / fw);
    // A line runs only across the grid, reaching just past it to close the corners.
    vec2 slack = fw * halfW;
    float inX = step(-slack.x, g.x) * step(g.x, uGrid.w + slack.x);
    float inY = step(-slack.y, g.y) * step(g.y, uGrid.w + slack.y);
    vec2 a = cov * mix(vec2(0.8), vec2(0.95), edge);
    c = mix(c, vec3(0.063, 0.043, 0.016), max(a.x * inY, a.y * inX));
  }
  float w = vWS;
  if(uFeather>0.0){
    float dx = min(vXY.x-vBox.x, vBox.z-vXY.x);
    float dy = min(vXY.y-vBox.y, vBox.w-vXY.y);
    w *= smoothstep(0.0,1.0,clamp(dx/uFeather,0.0,1.0))
       * smoothstep(0.0,1.0,clamp(dy/uFeather,0.0,1.0));
  }
  w *= pfade;
  o = vec4(c*w, w);   // additive accumulation; resolve divides rgb by a
}`;

// Backdrop: the mapped square, painted under everything.
export const BVS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aP;
uniform mat4 uVP; uniform vec2 uC; uniform float uHalf, uZ;
out vec2 wXY;
void main(){ wXY = uC + aP*uHalf; gl_Position = uVP*vec4(wXY, uZ, 1.0); }`;

// Backdrop colour.
export const BFS = `#version 300 es
precision highp float;
in vec2 wXY; out vec4 o;
void main(){ o = vec4(0.45,0.32,0.14,1.0); }`;

// Full-screen triangle strip for the resolve and decode passes.
export const RVS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aP;
out vec2 vUV;
void main(){ vUV=aP*0.5+0.5; gl_Position=vec4(aP,0.0,1.0); }`;

// Resolve: divide the premultiplied accumulation buffer through by its weight.
export const RFS = `#version 300 es
precision highp float;
uniform sampler2D uT; uniform vec2 uTexel; uniform float uSS;
in vec2 vUV; out vec4 o;
void main(){
  vec4 a = texture(uT,vUV);
  if(uSS>1.5){  // box-average the supersampled buffer, premultiplied
    a = (texture(uT,vUV+vec2( 0.5, 0.5)*uTexel)+texture(uT,vUV+vec2(-0.5, 0.5)*uTexel)
        +texture(uT,vUV+vec2( 0.5,-0.5)*uTexel)+texture(uT,vUV+vec2(-0.5,-0.5)*uTexel))*0.25;
  }
  if(a.a<=1.0e-4) discard;          // nothing drew here: let the backdrop show
  o = vec4(a.rgb/a.a, 1.0);
}`;

// Copies the frame's depth into a float target that can be read back.
export const DFS = `#version 300 es
precision highp float;
uniform highp sampler2D uD; in vec2 vUV; out vec4 o;
void main(){ o = vec4(texture(uD,vUV).r, 0.0, 0.0, 1.0); }`;

// Blit used to decode a compressed texture (BC7 detail, BC1 rock) into an RGBA8
// copy that can carry mips.
export const CFS = `#version 300 es
precision highp float;
uniform sampler2D uT; in vec2 vUV; out vec4 o;
void main(){ o = texture(uT,vUV); }`;
