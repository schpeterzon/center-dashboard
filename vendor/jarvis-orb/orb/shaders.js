import {
  SPIKE_AXES,
  SPIKE,
  RING,
  TORUS,
  LATTICE,
  GEAR,
  SLICE,
  EMIT,
  BLOOM,
  BLOOM_AXES,
  CHECK,
  FORM_DRIFT,
  STAGE_LIMIT,
} from "./forms.js";

// GLSL float literal, rounded so derived constants stay readable in the shader.
const f = (n) => {
  const text = String(Number(n.toFixed(6)));
  return text.includes(".") ? text : `${text}.0`;
};
const vec3s = (list) => list.map((a) => `vec3(${a.map((n) => n.toFixed(6)).join(",")})`).join(",");
const vec2 = ([x, y]) => `vec2(${x.toFixed(6)},${y.toFixed(6)})`;

// Movesets. Each form maps the resting body to a bounded target; weights are
// normalized by the controller (sum <= 1), so the blend never extrapolates.
// Keep in step with morphPoint() in forms.js, which the fallback and tests use.
const FORMS = `
uniform float uSpike, uRings, uTorus, uLattice, uGear, uSlice, uEmit, uBloom, uCheck, uJag, uBeat;
uniform mat3 uSpikeFrame, uTorusFrame, uLatticeFrame, uGearFrame, uBloomFrame, uCheckFrame;
uniform mat3 uRingFrames[3];
uniform vec3 uJet;
const vec3 SPIKE_AXES[${SPIKE_AXES.length}]=vec3[${SPIKE_AXES.length}](${vec3s(SPIKE_AXES)});
const vec3 BLOOM_AXES[${BLOOM_AXES.length}]=vec3[${BLOOM_AXES.length}](${vec3s(BLOOM_AXES)});
float gGlow, gFade;
float hash11(float n){return fract(sin(n)*43758.5453);}
vec3 spikeForm(float r, vec3 n){
  vec3 q=uSpikeFrame*n;
  float best=-2.; int id=0;
  for(int i=0;i<${SPIKE_AXES.length};i++){float d=dot(q,SPIKE_AXES[i]); if(d>best){best=d; id=i;}}
  vec3 axis=SPIKE_AXES[id];
  float u=min(1.,acos(clamp(best,-1.,1.))/${f(SPIKE.width)});
  float w=1.-u*u;
  float k=dot(axis,vec3(.52,.76,-.39));
  float swell=.5+.5*sin(uTime*1.7-k*k*6.);
  float glitch=hash11(float(id-(id/10)*10)*1.7+mod(floor(uTime*9.),97.)*.37);
  float len=${f(SPIKE.length)}*(.7+.3*swell)*(1.+(.35+.65*glitch-1.)*uJag);
  vec3 d=normalize(q+(axis-q)*${f(SPIKE.pinch)}*sqrt(w));
  gGlow=max(gGlow,w*.7*uSpike);
  return transpose(uSpikeFrame)*d*(r*${f(SPIKE.core)}*(1.+len*w));
}
vec3 ringForm(vec3 p, float seed, float shell, float group){
  if(group<.5 || shell<.9 || fract(seed*3.7)>=${f(RING.share)}) return p*${f(RING.nucleus)};
  int k=int(group+.5)-1;
  mat3 frame=k==0?uRingFrames[0]:k==1?uRingFrames[1]:uRingFrames[2];
  vec3 q=frame*p;
  float a=atan(q.y,q.x)+uTime*.55*(k==1?-1.:1.)*(1.+.12*float(k));
  float R=${f(RING.radius)}+(fract(seed*9.1)-.5)*.024;
  gGlow=max(gGlow,.55*uRings);
  return transpose(frame)*vec3(cos(a)*R,sin(a)*R,q.z*.03);
}
vec3 torusForm(float r, vec3 n){
  vec3 q=uTorusFrame*n;
  float phi=atan(q.z,q.x)+uTime*.32;
  float th=3.14159265*q.y+uTime*1.25;
  float tube=${f(TORUS.tube)}*min(1.,r/.98);
  float ring=${f(TORUS.radius)}+tube*cos(th);
  return transpose(uTorusFrame)*vec3(ring*cos(phi),tube*sin(th),ring*sin(phi));
}
vec3 latticeForm(float r, vec3 n, float shell){
  vec3 q=uLatticeFrame*n;
  vec3 a=abs(q);
  float hi=max(a.x,max(a.y,a.z)), lo=min(a.x,min(a.y,a.z));
  float mid=a.x+a.y+a.z-hi-lo;
  gGlow=max(gGlow,smoothstep(.82,1.,mid/max(hi,1e-4))*.8*uLattice);
  vec3 u=q/max(hi,1e-4);
  vec3 middle=step(lo+1e-6,a)*step(a,vec3(hi-1e-6));
  u+=sign(u)*middle*(1.-abs(u))*(shell>=.9?${f(LATTICE.edge)}:0.);
  return transpose(uLatticeFrame)*u*(${f(LATTICE.half)}*r);
}
vec3 gearForm(float r, vec3 n, float shell){
  vec3 q=uGearFrame*n;
  float rho=length(q.xz);
  float a=atan(q.z,q.x);
  float tooth=smoothstep(-.18,.18,sin(a*${f(GEAR.teeth)}));
  float rim=smoothstep(.8,.97,rho);
  float R=shell<.9?${f(GEAR.hub)}*min(1.,r/.55):${f(GEAR.inner)}+${f(GEAR.outer - GEAR.inner)}*rho*rho+${f(GEAR.depth)}*tooth*rim;
  gGlow=max(gGlow,tooth*rim*.6*uGear);
  return transpose(uGearFrame)*vec3(cos(a)*R,q.y*${f(GEAR.flatten)}*r,sin(a)*R);
}
vec3 sliceForm(vec3 p, float r, float shell){
  if(shell<.9) return p*${f(SLICE.core)};
  float band=floor(p.y*${f(SLICE.bands)}+.5);
  float level=band/${f(SLICE.bands)};
  float planar=sqrt(max(r*r-level*level,0.));
  vec2 xz=p.xz/max(length(p.xz),1e-4)*planar;
  float spin=uTime*.5*(mod(band,2.)*2.-1.);
  xz=mat2(cos(spin),sin(spin),-sin(spin),cos(spin))*xz;
  gGlow=max(gGlow,.35*uSlice);
  return vec3(xz.x,level,xz.y);
}
vec3 emitForm(vec3 p, vec3 n, float seed, float shell){
  if(shell>=.9) return p*${f(EMIT.shell)};
  float along=dot(n,uJet);
  float t=fract(seed*5.31+uTime*${f(EMIT.speed)});
  float reach=(along>=0.?1.:-1.)*mix(.24,${f(EMIT.reach)},t);
  gFade=1.+(smoothstep(0.,.12,t)*(1.-smoothstep(.72,1.,t))-1.)*uEmit;
  gGlow=max(gGlow,.5*uEmit);
  return uJet*reach+(n-uJet*along)*(.03+.08*t);
}
vec3 bloomForm(vec3 p, vec3 n){
  vec3 q=uBloomFrame*n;
  float peak=0.;
  for(int i=0;i<${BLOOM_AXES.length};i++) peak=max(peak,abs(dot(q,BLOOM_AXES[i])));
  float lobe=max(0.,(peak-${f(BLOOM.floor)})/${f(1 - BLOOM.floor)});
  return p*(${f(BLOOM.base)}+${f(BLOOM.swell)}*lobe*lobe);
}
vec3 checkForm(vec3 n, float seed, float shell){
  float along=fract(seed*9.)*${f(CHECK.first + CHECK.second)};
  vec2 a=${vec2(CHECK.points[0])}, b=${vec2(CHECK.points[1])}, c=${vec2(CHECK.points[2])};
  vec2 pt=along<${f(CHECK.first)}?mix(a,b,along/${f(CHECK.first)}):mix(b,c,(along-${f(CHECK.first)})/${f(CHECK.second)});
  float tube=shell<.9?${f(CHECK.glow)}:${f(CHECK.tube)};
  gGlow=max(gGlow,(shell<.9?.2:.7)*uCheck);
  return transpose(uCheckFrame)*(vec3(pt,0.)+n*tube);
}
vec3 applyForms(vec3 base, vec3 p, float seed, float shell, float group){
  // Forms are built from the stable origin geometry so silhouettes stay crisp; a
  // fraction of the organic drift rides on top to keep the body alive.
  float r=length(base);
  vec3 n=base/max(r,1e-4);
  vec3 life=(p-base)*${f(FORM_DRIFT)};
  vec3 o=p;
  if(uSpike>.001) o+=(spikeForm(r,n)+life-p)*uSpike;
  if(uRings>.001) o+=(ringForm(base,seed,shell,group)+life-p)*uRings;
  if(uTorus>.001) o+=(torusForm(r,n)+life-p)*uTorus;
  if(uLattice>.001) o+=(latticeForm(r,n,shell)+life-p)*uLattice;
  if(uGear>.001) o+=(gearForm(r,n,shell)+life-p)*uGear;
  if(uSlice>.001) o+=(sliceForm(base,r,shell)+life-p)*uSlice;
  if(uEmit>.001) o+=(emitForm(base,n,seed,shell)+life-p)*uEmit;
  if(uBloom>.001) o+=(bloomForm(base,n)+life-p)*uBloom;
  if(uCheck>.001) o+=(checkForm(n,seed,shell)+life-p)*uCheck;
  return o;
}
`;

// Native GLSL ES 3.00. All deformation is in object-space, before MVP projection.
// The flow is an analytic curl of a two-octave Fourier vector potential. Each
// octave is divergence-free (mixed partials cancel), unlike per-particle jitter.
export const PARTICLE_VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec4 aTraits; // seed, layer, weight, flow group
layout(location=2) in vec3 aNeighbor;
uniform mat4 uModel, uView, uProjection;
uniform float uTime, uPhase, uDpr, uDensity, uMotion, uEnergy;
uniform float uTurbulence, uSwirl, uWave, uFlow, uFocus, uPulse, uCluster, uFragment, uBurst, uScan;
uniform vec4 uAttention;
uniform float uPosture;
uniform bool uLines;
uniform vec3 uColor;
uniform vec4 uOrigins[8];
uniform vec4 uImpulses[8];
${FORMS}
out vec3 vColor;
out float vAlpha, vSharpness;
flat out int vGlyph;

vec3 curlOctave(vec3 p, float t) {
  vec3 k1=vec3(1.3, 2.1, 0.7), k2=vec3(-1.7, 0.8, 1.9), k3=vec3(0.6, -1.4, 2.3);
  vec3 c=cos(vec3(dot(k1,p)+t*.71, dot(k2,p)-t*.53, dot(k3,p)+t*.63));
  return vec3(k3.y*c.z-k2.z*c.y, k1.z*c.x-k3.x*c.z, k2.x*c.y-k1.y*c.x)*.27;
}
vec3 curlField(vec3 p, float t) {
  return curlOctave(p,t)+curlOctave(p*1.93+vec3(3.7,-2.4,1.2),t*.7)*.32;
}
vec3 deform(vec3 base, float seed, float layer, float group) {
  vec3 p=base;
  float radius=length(base);
  vec3 radial=base/max(radius,.001);
  vec3 flow=curlField(base*1.75,uPhase);
  p+=flow*uTurbulence*.82;
  // Differential internal circulation; no global rotating sphere.
  float angle=sin(uPhase*.6+radius*4.0)*uSwirl*.11;
  p.xz=mat2(cos(angle),-sin(angle),sin(angle),cos(angle))*p.xz;
  // A slow whole-body breath keeps the entity visibly alive; layered waves
  // create smaller local motions that strengthen when it is actively working.
  float breath=sin(uTime*.72)+.28*sin(uTime*.31+1.1);
  p*=1.0+breath*.018*uMotion;
  float cognition=sin(uPhase*.68+dot(base,vec3(4.1,-3.2,2.7))+sin(uPhase*.19+base.y*3.)) * cos(uPhase*.31+base.x*5.);
  p+=radial*cognition*(.008+uEnergy*.016)*uMotion;
  float wave=sin(radius*9.0-uPhase*2.2)*uWave*.036;
  p+=radial*wave;
  p.y+=sin(uPhase*1.5+base.y*3.0)*max(0.,uFlow)*.09;
  p+=radial*max(0.,-uFlow)*(.045+.055*sin(uPhase*2.0-radius*3.0));
  vec3 center=group<.5?vec3(.36,.3,.27):group<1.5?vec3(-.36,-.3,.27):group<2.5?vec3(-.36,.3,-.27):vec3(.36,-.3,-.27);
  float cluster=exp(-dot(base-center,base-center)*5.0)*uCluster;
  p+=(center-base)*cluster*.28;
  float scan=exp(-pow((base.y-sin(uPhase*.85)*1.1)*5.5,2.0))*uScan;
  p+=radial*scan*.045;
  // Approval/fallback attention is a lub-dub heartbeat rather than a constant wobble.
  p*=1.0+uBeat*uPulse*.05*uMotion;
  p+=radial*uFragment*(.04+.12*sin(dot(base,vec3(14.,9.,7.))+uPhase*4.));
  p*=1.0+uBurst*.12;
  p=applyForms(base,p,seed,layer,group);
  float attention=exp(-dot(base-uAttention.xyz,base-uAttention.xyz)*2.4)*uAttention.w;
  p+=(uAttention.xyz-base)*attention*(.045+uFocus*.05)*uMotion;
  p*=1.0-uPosture*.02*uMotion;
  p.z+=uPosture*.035*uMotion;
  for(int i=0;i<8;i++) {
    float age=uTime-uOrigins[i].w;
    float strength=uImpulses[i].y;
    if(age<0. || age>uImpulses[i].z || strength==0.) continue;
    vec3 delta=base-uOrigins[i].xyz;
    float d=length(delta);
    float envelope=pow(1.0-age/uImpulses[i].z,2.0);
    float shell=exp(-pow((d-age*.9)*9.0,2.0));
    float kind=uImpulses[i].x;
    float local=kind==3.?exp(-d*d*13.0):1.0;
    vec3 direction=delta/max(d,.01);
    p+=direction*shell*envelope*strength*.19*local*uMotion;
    if(kind==2.) p+=radial*exp(-radius*radius*4.0)*sin(age*2.0)*envelope*strength*.08*uMotion;
    if(kind==6.) p+=flow*envelope*strength*.18*uMotion;
  }
  // Soft limiter: stacked ripples on a spine tip ease into the stage edge, never past it.
  float reach=length(p);
  if(reach>${f(STAGE_LIMIT.knee)})
    p*=(${f(STAGE_LIMIT.knee)}+${f(STAGE_LIMIT.max - STAGE_LIMIT.knee)}*tanh((reach-${f(STAGE_LIMIT.knee)})/${f(STAGE_LIMIT.max - STAGE_LIMIT.knee)}))/reach;
  return p;
}
void main() {
  gGlow=0.;
  gFade=1.;
  vec3 p=deform(aPosition,aTraits.x,aTraits.y,aTraits.w);
  float glow=gGlow, fade=gFade;
  vec4 eye=uView*uModel*vec4(p,1.0);
  gl_Position=uProjection*eye;
  float depth=clamp((4.65+eye.z)/2.15,0.0,1.0);
  gl_PointSize=clamp((6.5+depth*3.0)*uDpr*3.6/-eye.z,5.,20.);
  vGlyph=int(floor(aTraits.x*5.0));
  float core=1.0-smoothstep(.12,.65,aTraits.y);
  float current=pow(.5+.5*sin(dot(p,vec3(7.,-5.,3.))+uPhase*1.5+1.8*sin(p.y*4.+p.z*3.-uPhase*.5)),8.0);
  vColor=uColor;
  vAlpha=(.10+depth*.42)*(.75+uEnergy*.35)*uDensity;
  vAlpha*=1.0+current*uSwirl*.4;
  // Inner particles stay dim unless a form carries them out to the surface.
  vAlpha*=mix(.45,1.0,smoothstep(.3,.8,max(aTraits.y,length(p))));
  // Spine tips, ring orbits and lattice edges carry a little more ink.
  vAlpha*=(1.0+glow*.6)*fade;
  vSharpness=mix(3.2,6.5,depth);
  for(int i=0;i<8;i++) {
    float age=uTime-uOrigins[i].w;
    if(age<0. || age>uImpulses[i].z || uImpulses[i].y==0.) continue;
    float d=length(aPosition-uOrigins[i].xyz);
    float wave=exp(-pow((d-age*.9)*7.0,2.0))*pow(1.0-age/uImpulses[i].z,2.0)*abs(uImpulses[i].y)*uMotion;
    if(uImpulses[i].x==3.) wave*=exp(-d*d*10.0);
    vec3 tint=uImpulses[i].x==5.?vec3(.26,.95,.68):uImpulses[i].x==6.?vec3(1.,.22,.4):uImpulses[i].x==4.?vec3(1.,.67,.24):uColor;
    vColor=mix(vColor,tint,clamp(wave*2.0,0.,1.));
    vAlpha+=wave*.4;
  }
  if(uLines) {
    // Re-evaluate the other endpoint with its own stable group/layer supplied
    // separately by the renderer's line shader below.
    vAlpha*=.12+.65*uCluster+.34*uSwirl;
    vAlpha*=pow(.5+.5*sin(uTime*.65+aTraits.x*35.),3.0);
  }
}
`;

// Partner attributes keep stretched/deformed links below a strict threshold.
export const LINE_VERTEX = PARTICLE_VERTEX.replace(
  "uniform mat4 uModel",
  "layout(location=3) in vec4 aNeighborTraits;\nuniform mat4 uModel",
).replace(
  "vAlpha*=.12+.65*uCluster+.34*uSwirl;",
  "vec3 other=deform(aNeighbor,aNeighborTraits.x,aNeighborTraits.y,aNeighborTraits.w);\n    vAlpha*=1.0-smoothstep(.19,.29,length(p-other));\n    vAlpha*=.12+.65*uCluster+.34*uSwirl;",
);

// Tiny local 5x7 glyph masks: dot, colon, plus, asterisk and hash.
// No font texture, external assets, network request or flat image of the sphere.
export const PARTICLE_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vColor;
in float vAlpha, vSharpness;
flat in int vGlyph;
out vec4 outColor;
void main() {
  ivec2 cell=ivec2(floor(gl_PointCoord*vec2(7.,9.)))-ivec2(1);
  if(cell.x<0 || cell.x>4 || cell.y<0 || cell.y>6) discard;
  int x=cell.x, y=cell.y;
  bool ink=false;
  if(vGlyph==0) ink=(x==2 && y==3);
  else if(vGlyph==1) ink=(x==2 && (y==2 || y==4));
  else if(vGlyph==2) ink=((x==2 && y>=1 && y<=5) || y==3);
  else if(vGlyph==3) ink=(y>=1 && y<=5 && (x==2 || y==3 || x==y-1 || x==5-y));
  else ink=((x==1 || x==3) && y>=1 && y<=5) || y==2 || y==4;
  if(!ink) discard;
  float alpha=clamp(vAlpha,0.,.85);
  outColor=vec4(vColor*alpha,alpha);
}`;
export const LINE_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vColor;
in float vAlpha;
out vec4 outColor;
void main(){outColor=vec4(vColor*vAlpha,vAlpha);}`;
export const QUAD_VERTEX = `#version 300 es
precision highp float;
out vec2 vUv;
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));vUv=p;gl_Position=vec4(p*2.-1.,0.,1.);}`;
export const BRIGHT_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uSource;
in vec2 vUv;
out vec4 outColor;
void main(){vec3 c=texture(uSource,vUv).rgb;float l=max(c.r,max(c.g,c.b));outColor=vec4(c*smoothstep(.2,.65,l),1.);}`;
export const BLUR_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform vec2 uStep;
in vec2 vUv;
out vec4 outColor;
void main(){
  vec3 c=texture(uSource,vUv).rgb*.227027;
  c+=(texture(uSource,vUv+uStep*1.384615).rgb+texture(uSource,vUv-uStep*1.384615).rgb)*.316216;
  c+=(texture(uSource,vUv+uStep*3.230769).rgb+texture(uSource,vUv-uStep*3.230769).rgb)*.070270;
  outColor=vec4(c,1.);
}`;
export const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uSource, uBloom;
uniform float uBloomStrength;
in vec2 vUv;
out vec4 outColor;
void main(){vec3 c=texture(uSource,vUv).rgb+texture(uBloom,vUv).rgb*uBloomStrength;c=clamp(c,0.,1.);outColor=vec4(c,max(c.r,max(c.g,c.b)));}`;
