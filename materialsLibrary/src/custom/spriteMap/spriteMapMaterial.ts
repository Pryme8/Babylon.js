
import { Engine } from "babylonjs/Engines/engine";
import { Texture } from "babylonjs/Materials/Textures/texture";
import { RawTexture } from "babylonjs/Materials/Textures/rawTexture";
import { ISpriteJSONAtlas } from "babylonjs/Sprites/ISprites";
import { ISpriteJSONSprite } from "babylonjs/Sprites/ISprites";
import { Vector2 } from "babylonjs/Maths/math.vector";
import { Vector3 } from "babylonjs/Maths/math.vector";
import { Scene } from "babylonjs/scene";
import { Nullable } from "babylonjs/types";
import { _TypeStore } from 'babylonjs/Misc/typeStore';
import { CustomMaterial } from "../customMaterial";
interface ISpriteMapMaterial{
    scene: Scene;
    stageSize: Vector2;
    atlas: ISpriteJSONAtlas;
    diffuse: Texture;
    bump?: Texture;
    specular?: Texture;
    outputSize?: Vector2;
    layerCount?: number;
    maxAnimationFrames?: number;
    baseTile?: number;
    flipU?: boolean;
    colorMultiply?: Vector3;
}

export class SpriteMapMaterial extends CustomMaterial{

    get scene(): Scene {
        return this.params.scene;
    }

    get sprites(): ISpriteJSONSprite[] {
        return this.params.atlas.frames;
    }

    get spriteCount(): number {
        return this.sprites.length;
    }

    private _frameBuffer: RawTexture;
    private _tileBuffers: RawTexture[] = [];
    private _animationBuffer: RawTexture;
    private time: number = 0;

    private defines: string[] = [];

    constructor(name: string, private params: ISpriteMapMaterial) {
        super(name, params.scene);
        this.params.outputSize = params.outputSize ?? params.stageSize;
        this.params.layerCount = params.layerCount ?? 1;
        this.params.maxAnimationFrames = params.maxAnimationFrames ?? 1;
        this.params.baseTile = params.baseTile ?? 0;
        this.params.flipU = params.flipU ?? false;
        this.params.colorMultiply = params.colorMultiply ?? Vector3.One();

        this._buildFrameBuffer();
        this._animationBuffer = this._createTileAnimationBuffer(null);

        this.diffuseTexture = this._createBlankRaw();
        this.alpha = 0;

        for (let i = 0; i < this.params.layerCount; i++) {
            this._tileBuffers.push(this._createTileBuffer(null, i));
        }

        this.defines.push(`const int LAYERS = int(${this.params.layerCount});`);
        if (this.params.flipU) {
            this.defines.push(`#define FLIPU`);
        }

        this.defines.push(`const float MAX_ANIMATION_FRAMES = float(${this.params.maxAnimationFrames});`);

        if (this.params.bump) {
            this.defines.push(`#define SPRITEBUMP`);
            this.bumpTexture = this._createBlankRaw();
        }

        if (this.params.specular) {
            this.defines.push(`#define SPRITESPECULAR`);
            this.specularTexture = this._createBlankRaw();
        }

        this.AddUniform('time', 'float', this.time);
        this.AddUniform('spriteCount', 'float', this.spriteCount);
        this.AddUniform('spriteDiffuse', 'sampler2D', this.params.diffuse);
        if (this.params.bump) {
            this.AddUniform('spriteNormal', 'sampler2D', this.params.bump);
        }
        if (this.params.specular) {
            this.AddUniform('spriteSpecular', 'sampler2D', this.params.specular);
        }

        this.AddUniform('colorMultiply', 'vec3', this.params.colorMultiply);

        const spriteMapSize = new Vector2(0, 0);
        this.AddUniform('spriteMapSize', 'vec2', spriteMapSize);
        this.AddUniform('outputSize', 'vec2', this.params.outputSize);
        this.AddUniform('stageSize', 'vec2', this.params.stageSize);
        this.AddUniform('frameBuffer', 'sampler2D', this._frameBuffer);
        this.AddUniform('animationBuffer', 'sampler2D', this._animationBuffer);
        this._customUniform.push(`uniform sampler2D tileBuffers[int(${this.params.layerCount})];`);
        this._newUniforms.push('tileBuffers');

        if(!this.params.diffuse.isReady()){
            this.params.diffuse.onLoadObservable.add(() => {
                spriteMapSize.set(this.params.diffuse._texture?.baseWidth ?? 1, this.params.diffuse._texture?.baseHeight ?? 1);
            });
        }else{
            spriteMapSize.set(this.params.diffuse._texture?.baseWidth ?? 1, this.params.diffuse._texture?.baseHeight ?? 1);
        }


        this.onBindObservable.addOnce(() => {
            const effect = this.getEffect();
            effect.setTextureArray('tileBuffers', this._tileBuffers);
            effect.setTexture('spriteDiffuse', this.params.diffuse);
            effect.setTexture('frameBuffer', this._frameBuffer);
            effect.setTexture('animationBuffer', this._animationBuffer);
        });

        this.Vertex_Definitions(`varying vec2 tUV;`);
        this.Vertex_MainEnd(`tUV = uv * stageSize;`);

        let defineString = `varying vec2 tUV;
        `;

        this.defines.forEach((def) => {
            defineString += def + `
            `;
        });

        this.Fragment_Begin(defineString);

        this.Fragment_Definitions(`
        float mt;
        const float fdStep = 1. / 4.;
        const float aFrameSteps = 1. / MAX_ANIMATION_FRAMES;

        mat4 getFrameData(float frameID){
            float fX = frameID / spriteCount;
            return mat4(
                texture2D(frameBuffer, vec2(fX, 0.), 0.),
                texture2D(frameBuffer, vec2(fX, fdStep * 1.), 0.),
                texture2D(frameBuffer, vec2(fX, fdStep * 2.), 0.),
                vec4(0.)
            );
        }

        float alphaFinal = 1.0;

        #ifdef SPRITEBUMP
            vec3 sNorm = vec3(0.);
        #endif
        #ifdef SPRITESPECULAR
            vec3 sSpec = vec3(0.);
        #endif
        `);

        let layerSampleString = ``;
        if (!this.scene.getEngine()._features.supportSwitchCaseInShader) {
            layerSampleString = "";
            for (let i = 0; i < this.params.layerCount; i++) {
                layerSampleString += `if (${i} == i) { frameID = texture2D(tileBuffers[int(${i}], (tileID + 0.5) / stageSize, 0.).x; }`;
            }
        }
        else {
            layerSampleString = "switch(i) {";
            for (let i = 0; i < this.params.layerCount; i++) {
                layerSampleString += `case ${i}: frameID = texture(tileBuffers[${i}], (tileID + 0.5) / stageSize, 0.).x;`;
                layerSampleString += "break;";
            }
            layerSampleString += "}";
        }

        this.Fragment_Custom_Diffuse(
        `
        vec4 sColor = vec4(0.);
        vec2 tileUV = fract(tUV);
        #ifdef FLIPU
            tileUV.y = 1.0 - tileUV.y;
        #endif

        vec2 tileID = floor(tUV);
        vec2 sheetUnits = 1. / spriteMapSize;
        float spriteUnits = 1. / spriteCount;
        vec2 stageUnits = 1. / stageSize;

        for(int i = 0; i < LAYERS + 1; i++) {
            float frameID;

            ${layerSampleString}

            vec4 animationData = texture2D(animationBuffer, vec2((frameID + 0.5) / spriteCount, 0.), 0.);
            if(animationData.y > 0.) {
                mt = mod(time*animationData.z, 1.0);
                for(float f = 0.; f < MAX_ANIMATION_FRAMES; f++){
                    if(animationData.y > mt){
                        frameID = animationData.x;
                        break;
                    }
                    animationData = texture2D(animationBuffer, vec2((frameID + 0.5) / spriteCount, aFrameSteps * f), 0.);
                }
            }

            //Get Animation Frame
            mat4 frameData = getFrameData(frameID + 0.5);
            vec2 frameSize = (frameData[0].wz) / spriteMapSize;
            vec2 offset = frameData[0].xy * sheetUnits;
            vec2 ratio = frameData[2].xy / frameData[0].wz;

            //rotated
            if (frameData[2].z == 1.){
                tileUV.xy = tileUV.yx;
            }

            if (i == 0){
                sColor = texture2D(spriteDiffuse, (tileUV * frameSize) + offset);
                #ifdef SPRITEBUMP
                sNorm = texture2D(spriteNormal, tileUV * frameSize+offset).rgb;
                #endif
                #ifdef SPRITESPECULAR
                sSpec = texture2D(spriteSpecular, tileUV * frameSize+offset).rgb;
                #endif
            } else {
                vec4 nc = texture2D(spriteDiffuse, (tileUV * frameSize) + offset);
                float alpha = min(sColor.a + nc.a, 1.0);
                vec3 mixed = mix(sColor.xyz, nc.xyz, nc.a);
                sColor = vec4(mixed, alpha);
                #ifdef SPRITEBUMP
                    vec4 nn = texture2D(spriteNormal, tileUV * frameSize+offset);
                    sNorm = normalize(mix(sNorm.xyz, nn.xyz, nc.a));
                #endif
                #ifdef SPRITESPECULAR
                    vec4 ns = texture2D(spriteSpecular, (tileUV * frameSize) + offset);
                    vec3 sMixed = mix(sSpec, ns.xyz, nc.a);
                    sSpec = sMixed;
                #endif
            }
        }
        diffuseColor = sColor.rgb;
        alphaFinal = sColor.a;
        `
        );

        this.Fragment_After_Specular(
        `
        #ifdef SPRITEBUMP
            normalW = perturbNormal(TBN, sNorm, vBumpInfos.y);
        #endif

        #ifdef SPRITESPECULAR
        specularColor = sSpec;
        #endif
        `
        );

        this.Fragment_Before_FragColor(`
            color.rgb *= colorMultiply;
            color.a = alphaFinal * visibility;
        `);

    }

    private _createBlankRaw(): RawTexture {
        const blank = RawTexture.CreateRGBATexture(
            new Uint8Array([255, 255, 255, 1]),
            1,
            1,
            this.scene
        );

        blank.name = this.name + ":blankBuffer";
        return blank;
    }

    private _buildFrameBuffer(): void {
        const data = new Array();
        //Do two Passes
        for (let i = 0; i < this.spriteCount; i++) {
            data.push(0, 0, 0, 0); //frame
            data.push(0, 0, 0, 0); //spriteSourceSize
            data.push(0, 0, 0, 0); //sourceSize, rotated, trimmed
            data.push(0, 0, 0, 0); //Keep it pow2 cause I"m cool like that... it helps with sampling accuracy as well. Plus then we have 4 other parameters for future stuff.
        }
        //Second Pass
        for (let i = 0; i < this.spriteCount; i++) {
            const f = this.sprites[i]["frame"];
            const sss = this.sprites[i]["spriteSourceSize"];
            const ss = this.sprites[i]["sourceSize"];
            const r = (this.sprites[i]["rotated"]) ? 1 : 0;
            const t = (this.sprites[i]["trimmed"]) ? 1 : 0;
            //frame
            data[i * 4] = f.x;
            data[i * 4 + 1] = f.y;
            data[i * 4 + 2] = f.w;
            data[i * 4 + 3] = f.h;
            //spriteSourceSize
            data[i * 4 + (this.spriteCount * 4)] = sss.x;
            data[i * 4 + 1 + (this.spriteCount * 4)] = sss.y;
            data[i * 4 + 3 + (this.spriteCount * 4)] = sss.h;
            //sourceSize, rotated, trimmed
            data[i * 4 + (this.spriteCount * 8)] = ss.w;
            data[i * 4 + 1 + (this.spriteCount * 8)] = ss.h;
            data[i * 4 + 2 + (this.spriteCount * 8)] = r;
            data[i * 4 + 3 + (this.spriteCount * 8)] = t;
        }

        const floatArray = new Float32Array(data);

        this._frameBuffer = RawTexture.CreateRGBATexture(
            floatArray,
            this.spriteCount,
            4,
            this.scene,
            false,
            false,
            Texture.NEAREST_NEAREST,
            Engine.TEXTURETYPE_FLOAT
        );

        this._frameBuffer.name = `${this.name}:frameBuffer`;
    }

    private _createTileBuffer(buffer: any, _layer: number = 0): RawTexture {
        let data = new Array();
        let _ty = (this.params.stageSize!.y) || 0;
        let _tx = (this.params.stageSize!.x) || 0;

        if (!buffer) {
            let bt = this.params.baseTile;
            if (_layer != 0) {
                bt = 0;
            }

            for (let y = 0; y < _ty; y++) {
                for (let x = 0; x < _tx * 4; x += 4) {
                    data.push(bt, 0, 0, 0);
                }
            }
        } else {
            data = buffer;
        }

        let floatArray = new Float32Array(data);
        let t = RawTexture.CreateRGBATexture(
            floatArray,
            _tx,
            _ty,
            this.scene,
            false,
            false,
            Texture.NEAREST_NEAREST,
            Engine.TEXTURETYPE_FLOAT
        );

        return t;
    }

    private _createTileAnimationBuffer(buffer: Nullable<ArrayBufferView>): RawTexture {
        let data = new Array();
        let floatArray;
        const maxAnimationFrames = this.params.maxAnimationFrames ?? 1;
        if (!buffer) {
            for (let i = 0; i < this.spriteCount; i++) {
                data.push(0, 0, 0, 0);
                for (let j = 1; j < maxAnimationFrames; j++) {
                    data.push(0, 0, 0, 0);
                }
            }
            floatArray = new Float32Array(data);
        } else {
            floatArray = buffer;
        }

        let t = RawTexture.CreateRGBATexture(
            floatArray,
            this.spriteCount,
            maxAnimationFrames,
            this.scene,
            false,
            false,
            Texture.NEAREST_NEAREST,
            Engine.TEXTURETYPE_FLOAT
        );

        return t;
    }

    public addAnimationToTile(cellID: number = 0, _frame: number = 0, toCell: number = 0, time: number = 0, speed: number = 1): void {
        let buffer: any = this._animationBuffer!._texture!._bufferView;
        let id: number = (cellID * 4) + (this.spriteCount * 4 * _frame);
        if (!buffer) {
            return;
        }
        buffer[id] = toCell;
        buffer[id + 1 ] = time;
        buffer[id + 2 ] = speed;
        let t = this._createTileAnimationBuffer(buffer);
        this._animationBuffer.dispose();
        this._animationBuffer = t;
        this.onBindObservable.addOnce(() => {
            this.getEffect().setTexture("animationBuffer", this._animationBuffer);
        });
    }

    public changeTiles(_layer: number = 0, pos: Vector2 | Vector2[] , tile: number = 0): void {
        let buffer: Nullable<ArrayBufferView>;
        buffer = this._tileBuffers[_layer]!._texture!._bufferView;
        if (buffer === null) {
            return;
        }

        let p = new Array();
        if (pos instanceof Vector2) {
            p.push(pos);
        } else {
            p = pos;
        }

        let _tx = (this.params.stageSize!.x) || 0;

        for (let i = 0; i < p.length; i++) {
            let _p = p[i];
            _p.x = Math.floor(_p.x);
            _p.y = Math.floor(_p.y);
            let id: number = (_p.x * 4) + (_p.y * (_tx * 4));
            (buffer as any)[id] = tile;
        }

        let t = this._createTileBuffer(buffer);
        this._tileBuffers[_layer].dispose();
        this._tileBuffers[_layer] = t;
        this.onBindObservable.addOnce(() => {
            this.getEffect().setTextureArray("tileBuffers", this._tileBuffers);
        });
    }
}

_TypeStore.RegisteredTypes["BABYLON.SpriteMapMaterial"] = SpriteMapMaterial;
