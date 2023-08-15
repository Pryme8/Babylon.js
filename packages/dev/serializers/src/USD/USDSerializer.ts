import { VertexBuffer } from "core/Buffers/buffer";
import { Camera } from "core/Cameras/camera";
import { PBRMaterial } from "core/Materials/PBR/pbrMaterial";
import { Texture } from "core/Materials/Textures/texture";
import { DynamicTexture } from "core/Materials/Textures/dynamicTexture";
import { type Color3, type Matrix, Vector2 } from "core/Maths/math";
import { type AbstractMesh } from "core/Meshes/abstractMesh";
import { type TransformNode } from "core/Meshes/transformNode";
import { type Scene } from "core/scene";
import { type Material } from "core/Materials/material";
import { Tools } from "core/Misc/tools";
import { type Nullable, type FloatArray } from "core/types";
import { isNoopNode } from "serializers/glTF/2.0/glTFExporter";
import { type Node } from "core/node";

/* Converted from https://github.com/mrdoob/three.js/blob/dev/examples/jsm/exporters/USDZExporter.js */

/**
 *  Options for exporting to USDZ.
 */
export interface IUSDExportOptions {
    /**
     * Name of the model.
     */
    modelName?: string;
    /**
     *  TODO get more information on USDZ options
     */
    quickLookCompatible?: boolean;
    /**
     *  TODO get more information on USDZ options
     */
    ar?: IUSDArOptions;

    /**
     * String to Uint8Array function. ffFlate is used by default.
     */
    strToU8: (str: string) => Uint8Array;
    /**
     * Zip function. ffFlate is used by default.
     */
    zipSync: (data: any, options: any) => Uint8Array;
}

/**
 *  TODO get more information on USDZ options
 */
interface IUSDArOptions {
    anchoring: {
        type: "plane" | "point";
    };
    planeAnchoring: {
        alignment: "horizontal" | "vertical";
    };
}

/**
 * Class for generating USD data from a Babylon scene.
 */
export class USDExport {
    /**
     * Float Rounding Precision
     */
    public static Precision: number = 7;

    /**
     * Default Camera export values
     * TODO get more information on these values and how they relate to Babylon Cameras
     */
    public static FilmGauge: number = 35;

    /**
     * Default Camera export values
     * TODO get more information on these values and how they relate to Babylon Cameras
     */
    public static Focus: number = 10;

    private static _LastOptions: IUSDExportOptions;

    /**
     * Export Scene as USDZ file.
     * @param options TODO get more information on USDZ options
     * @param scene to export
     * @param autoDownload automatically download the file.
     * @returns a promise with the data of the USDZ file.
     */
    public static async ExportAsBinaryZip(options: IUSDExportOptions, scene: Scene, autoDownload: boolean = true) {
        options = {
            ar: {
                anchoring: { type: "plane" },
                planeAnchoring: { alignment: "horizontal" },
            },
            quickLookCompatible: false,
            ...options,
        };

        USDExport._LastOptions = options;

        const files: any = {};
        const modelFileName = `${options?.modelName || "model"}.usda`;
        files[modelFileName] = null;

        let output: string = USDExport._BuildHeader();
        output += USDExport._BuildSceneStart(options);

        const materials: { [id: string]: Material } = {};
        const textures: { [id: string]: Texture } = {};

        const sharedMat: PBRMaterial = new PBRMaterial(`default.mat`, scene);

        scene.meshes
            .filter((mesh) => (mesh as any).geometry)
            .forEach((mesh) => {
                const material = mesh.material ?? sharedMat;
                const geometryFileName: string = "geometries/Geometry_" + mesh.uniqueId + ".usda";
                let rootParent: Nullable<Node> = mesh;
                let target: Nullable<Node> = mesh;

                while (target?.parent) {
                    rootParent = target;
                    target = mesh.parent;
                }

                rootParent = rootParent ?? mesh;
                const noopNode = rootParent && isNoopNode(rootParent, scene.useRightHandedSystem) && !scene.useRightHandedSystem;
                if (noopNode) {
                    (mesh.parent as TransformNode).scaling.z = 1;
                }
                switch (material.getClassName()) {
                    case "PBRMaterial":
                        if (!(geometryFileName in files)) {
                            const meshObject = USDExport._BuildMeshObject(mesh);
                            files[geometryFileName] = USDExport._BuildUSDFileAsString(meshObject);
                        }

                        if (!(material.uniqueId in materials)) {
                            materials[material.uniqueId] = material;
                        }

                        output += USDExport._BuildXform(mesh, material);

                        break;
                    default:
                        Tools.Warn("USDExporter: Standard Material is not supported currently.");
                        break;
                }
                if (noopNode) {
                    (mesh.parent as TransformNode).scaling.z = -1;
                }
            });

        if (scene.activeCameras?.length) {
            scene.activeCameras.forEach((camera) => {
                output += USDExport._BuildCamera(camera);
            });
        } else if (scene.activeCamera) {
            output += USDExport._BuildCamera(scene.activeCamera);
        }

        output += USDExport._BuildSceneEnd();

        output += await USDExport._BuildMaterials(materials, textures, options.quickLookCompatible);

        files[modelFileName] = options.strToU8(output);

        for (const id in textures) {
            const texture = textures[id];
            const image = await USDExport._TextureToImage(texture);
            const canvas = USDExport._ImageToCanvas(image, texture.invertY);
            const blob: Blob | null = await new Promise((resolve: BlobCallback) => {
                canvas.toBlob(resolve, "image/png", 1);
            });
            if (blob) {
                files[`textures/Texture_${id}.png`] = new Uint8Array(await blob.arrayBuffer());
            }
        }

        // 64 byte alignment
        // https://github.com/101arrowz/fflate/issues/39#issuecomment-777263109
        let offset = 0;
        for (const filename in files) {
            const file = files[filename];
            const headerSize = 34 + filename.length;
            offset += headerSize;
            const offsetMod64 = offset & 63;

            if (offsetMod64 !== 4) {
                const padLength = 64 - offsetMod64;
                const padding = new Uint8Array(padLength);
                // eslint-disable-next-line @typescript-eslint/naming-convention
                files[filename] = [file, { extra: { 12345: padding } }];
            }

            offset = file.length;
        }

        const data = options.zipSync(files, { level: 0 });

        if (autoDownload) {
            Tools.Download(new Blob([data], { type: "application/octet-stream" }), `${options?.modelName || "model"}.usdz`);
        }

        sharedMat.dispose();

        return data;
    }

    private static _BuildHeader() {
        return `#usda 1.0
    (
        customLayerData = {
            string creator = "Babylon.js USDExport"
        }
        metersPerUnit = 1
        upAxis = "Y"
    )
    
    `;
    }

    private static _BuildSceneStart(options: any) {
        return `def Xform "Root"
    {
        def Scope "Scenes" (
            kind = "sceneLibrary"
        )
        {
            def Xform "Scene" (
                customData = {
                    bool preliminary_collidesWithEnvironment = 0
                    string sceneName = "Scene"
                }
                sceneName = "Scene"
            )
            {
            token preliminary:anchoring:type = "${options.ar.anchoring.type}"
            token preliminary:planeAnchoring:alignment = "${options.ar.planeAnchoring.alignment}"
    
    `;
    }

    private static _BuildSceneEnd() {
        return `
    
            }
        }
    }
    
    `;
    }

    private static _BuildMeshObject(_mesh: AbstractMesh) {
        const mesh = USDExport._BuildMesh(_mesh);
        return `
    def "Geometry"
    {
    ${mesh}
    }
    `;
    }

    private static _BuildMesh(mesh: AbstractMesh) {
        const positions = mesh.getVerticesData(VertexBuffer.PositionKind) ?? [];
        const count = positions?.length ?? 0;
        const normals = mesh.getVerticesData(VertexBuffer.NormalKind) ?? [];
        const normalCount = normals?.length ?? 0;

        return `
      def Mesh "mesh_${mesh.uniqueId}"
      {
        int[] faceVertexCounts = [${USDExport._BuildMeshVertexCount(count)}]
        int[] faceVertexIndices = [${USDExport._BuildMeshVertexIndices(mesh)}]
        normal3f[] normals = [${USDExport._BuildVector3Array(normalCount, normals as number[])}] (
          interpolation = "vertex"
        )
        point3f[] points = [${USDExport._BuildVector3Array(count, positions as number[])}]
    ${USDExport._BuildPrimVars(mesh)}
        uniform token subdivisionScheme = "none"
      }
    `;
    }

    private static _BuildMeshVertexCount(positionCount: number) {
        return Array(positionCount / 3)
            .fill(3)
            .join(", ");
    }

    private static _BuildMeshVertexIndices(mesh: AbstractMesh) {
        const indices = mesh.getIndices() ?? [];
        const array = [];

        for (let i = 0; i < indices.length; i++) {
            array.push(indices[i]);
        }

        return array.join(", ");
    }

    private static _BuildVector3Array(count: number, attribute?: FloatArray) {
        if (attribute === undefined) {
            Tools.Warn("USDExporter: Normals missing.");
            return Array(count / 3)
                .fill("(0, 0, 0)")
                .join(", ");
        }

        const array = [];

        for (let i = 0; i < count; i += 3) {
            const x = attribute[i];
            const y = attribute[i + 1];
            const z = attribute[i + 2];
            array.push(`(${x.toPrecision(USDExport.Precision)}, ${y.toPrecision(USDExport.Precision)}, ${z.toPrecision(USDExport.Precision)})`);
        }

        return array.join(", ");
    }

    private static _BuildVector2Array(count: number, attribute?: FloatArray) {
        if (!attribute?.length) {
            Tools.Warn("USDExporter: UVs missing.");
            return Array(count / 2)
                .fill("(0, 0)")
                .join(", ");
        }

        const array = [];

        for (let i = 0; i < count; i += 2) {
            const x: number = attribute[i];
            const y: number = 1 - attribute[i + 1];
            array.push(`(${x.toPrecision(USDExport.Precision)}, ${y.toPrecision(USDExport.Precision)})`);
        }
        return array.join(", ");
    }

    private static _BuildPrimVars(mesh: AbstractMesh) {
        let output = "";
        const count = ((mesh.getVerticesData(VertexBuffer.PositionKind) ?? []).length / 3) * 2;
        const uvList = [
            mesh.getVerticesData(VertexBuffer.UVKind) ?? [],
            mesh.getVerticesData(VertexBuffer.UV2Kind) ?? [],
            mesh.getVerticesData(VertexBuffer.UV3Kind) ?? [],
            mesh.getVerticesData(VertexBuffer.UV4Kind) ?? [],
        ];
        uvList.forEach((uv, id) => {
            if (uv.length) {
                output += USDExport._BuildUV(uv, 0, count);
            }
        });
        return output;
    }

    private static _BuildUV(uv: FloatArray, id: number, count: number) {
        let output = "";
        if (uv?.length > 0) {
            output += `
            texCoord2f[] primvars:st${id} = [${USDExport._BuildVector2Array(count, uv)}] (
                interpolation = "vertex"
            )`;
        }

        return output;
    }

    private static _BuildXform(mesh: AbstractMesh, material: Material) {
        const name = "Object_" + mesh.uniqueId;
        const mat = mesh.getWorldMatrix();
        const transform = USDExport._BuildMatrix(mat);

        if (mat.determinant() < 0) {
            Tools.Warn(`USDExport: USDZ does not support negative scales on nodes: ${mesh.name}`);
        }

        return `def Xform "${name}" (
        prepend references = @./geometries/Geometry_${mesh.uniqueId}.usda@</Geometry>
        prepend apiSchemas = ["MaterialBindingAPI"]
    )
    {
        matrix4d xformOp:transform = ${transform}
        uniform token[] xformOpOrder = ["xformOp:transform"]
        rel material:binding = </Materials/Material_${material.uniqueId}>
    }
    `;
    }

    private static _BuildMatrix(matrix: Matrix) {
        const array = matrix.toArray() as number[];
        return `( ${USDExport._BuildMatrixRow(array, 0)}, ${USDExport._BuildMatrixRow(array, 4)}, ${USDExport._BuildMatrixRow(array, 8)}, ${USDExport._BuildMatrixRow(
            array,
            12
        )} )`;
    }

    private static _BuildMatrixRow(array: number[], offset: number) {
        return `(${array[offset + 0]}, ${array[offset + 1]}, ${array[offset + 2]}, ${array[offset + 3]})`;
    }

    private static _BuildCamera(camera: Camera) {
        const name = `${camera.name}_${camera.uniqueId}`;
        const mat = camera.getWorldMatrix();

        const transform = USDExport._BuildMatrix(mat);

        if (mat.determinant() < 0) {
            Tools.Warn(`USDExport: USDZ does not support negative scales on camera: ${camera.name}`);
        }

        if (camera.mode === Camera.ORTHOGRAPHIC_CAMERA) {
            return `def Camera "${name}"
                {
                    matrix4d xformOp:transform = ${transform}
                    uniform token[] xformOpOrder = ["xformOp:transform"]
                    float2 clippingRange = (${camera.minZ.toPrecision(USDExport.Precision)}, ${camera.maxZ.toPrecision(USDExport.Precision)})
                    float horizontalAperture = ${((Math.abs(camera.orthoLeft ?? 0) + Math.abs(camera.orthoRight ?? 0)) * 10).toPrecision(USDExport.Precision)}
                    float verticalAperture = ${((Math.abs(camera.orthoTop ?? 0) + Math.abs(camera.orthoBottom ?? 0)) * 10).toPrecision(USDExport.Precision)}
                    token projection = "orthographic"
                }`;
        } else {
            return `def Camera "${name}"
                {
                    matrix4d xformOp:transform = ${transform}
                    uniform token[] xformOpOrder = ["xformOp:transform"]
                    float2 clippingRange = (${camera.minZ.toPrecision(USDExport.Precision)}, ${camera.maxZ.toPrecision(USDExport.Precision)})
                    float focalLength = ${camera.fov.toPrecision(USDExport.Precision)}
                    float focusDistance = ${USDExport.Focus.toPrecision(USDExport.Precision) /*THIS IS PROBABLY WRONG*/}
                    float horizontalAperture = ${USDExport.FilmGauge.toPrecision(USDExport.Precision) /*THIS IS PROBABLY WRONG*/} 
                    token projection = "perspective"
                    float verticalAperture = ${USDExport.FilmGauge.toPrecision(USDExport.Precision) /*THIS IS PROBABLY WRONG*/}
                }`;
        }
    }

    private static async _BuildMaterials(materials: any, textures: any, quickLookCompatible: boolean = false) {
        const array = [];
        for (const uuid in materials) {
            const material = materials[uuid];

            array.push(await USDExport._BuildMaterial(material, textures, quickLookCompatible));
        }

        return `def "Materials"
    {
    ${array.join("")}
    }
    `;
    }

    private static async _BuildMaterial(_material: Material, textures: any, quickLookCompatible = false) {
        // https://graphics.pixar.com/usd/docs/UsdPreviewSurface-Proposal.html
        const pad = "			";
        const inputs = [];
        const samplers = [];
        const material = _material as PBRMaterial;
        const scene = material.getScene();

        const channelIndexMap: { [key: string]: number } = {
            r: 0,
            g: 1,
            b: 2,
            a: 3,
        };

        async function createDynamicTextureFromChannel(texture: Texture, channel: string) {
            const dt = new DynamicTexture("dt", { width: texture.getSize().width, height: texture.getSize().height }, scene, false);
            const ctx = dt.getContext();
            const img = (await texture.readPixels()) as any;
            const data = (ctx as any).createImageData(texture.getSize().width, texture.getSize().height);
            const count = texture.getSize().width * texture.getSize().height * 4;

            for (let i = 0; i < count; i += 4) {
                const value = channel === "r" ? 255 - img[i + channelIndexMap[channel]] : img[i + channelIndexMap[channel]];
                data.data[i] = value;
                data.data[i + 1] = value;
                data.data[i + 2] = value;
                data.data[i + 3] = 255;
            }

            ctx.putImageData(data, 0, 0);
            dt.update(texture.invertY);
            return dt;
        }

        async function breakApartMetallicRoughnessAo(texture: Texture) {
            const ao = await createDynamicTextureFromChannel(texture, "r");
            ao.name = "ao";
            const roughness = await createDynamicTextureFromChannel(texture, "g");
            roughness.name = "roughness";
            const metallic = await createDynamicTextureFromChannel(texture, "b");
            metallic.name = "metallic";
            return { ao, roughness, metallic };
        }

        function buildTexture(texture: Texture, mapType: string, color: Color3 | undefined = undefined) {
            const id = texture.uniqueId + "_" + texture.invertY;
            textures[id] = texture;

            const uv = texture.coordinatesIndex > 0 ? `st${texture.coordinatesIndex}` : `st`;

            /* TODO CHECK THIS */
            const WRAPPINGS = [
                "clamp", // ClampToEdgeWrapping
                "repeat", // RepeatWrapping
                "mirror", // MirroredRepeatWrapping
            ];

            const repeat = new Vector2(texture.wrapU === Texture.CLAMP_ADDRESSMODE ? 0 : 1, texture.wrapV === Texture.CLAMP_ADDRESSMODE ? 0 : 1);
            const offset = new Vector2(texture.uOffset, texture.vOffset);
            const rotation = texture.wAng ?? 0;

            // rotation is around the wrong point. after rotation we need to shift offset again so that we're rotating around the right spot
            const xRotationOffset = Math.sin(rotation);
            const yRotationOffset = Math.cos(rotation);

            // texture coordinates start in the opposite corner, need to correct
            offset.y = 1 - offset.y - repeat.y;

            // turns out QuickLook is buggy and interprets texture repeat inverted/applies operations in a different order.
            // Apple Feedback: 	FB10036297 and FB11442287
            if (quickLookCompatible) {
                // This is NOT correct yet in QuickLook, but comes close for a range of models.
                // It becomes more incorrect the bigger the offset is
                offset.x = offset.x / repeat.x;
                offset.y = offset.y / repeat.y;

                offset.x += xRotationOffset / repeat.x;
                offset.y += yRotationOffset - 1;
            } else {
                // results match glTF results exactly. verified correct in usdview.
                offset.x += xRotationOffset * repeat.x;
                offset.y += (1 - yRotationOffset) * repeat.y;
            }

            return `
            def Shader "PrimvarReader_${mapType}"
            {
                uniform token info:id = "UsdPrimvarReader_float2"
                float2 inputs:fallback = (0.0, 0.0)
                token inputs:varname = "${uv}"
                float2 outputs:result
            }
            def Shader "Transform2d_${mapType}"
            {
                uniform token info:id = "UsdTransform2d"
                token inputs:in.connect = </Materials/Material_${material.uniqueId}/PrimvarReader_${mapType}.outputs:result>
                float inputs:rotation = ${(rotation * (180 / Math.PI)).toFixed(USDExport.Precision)}
                float2 inputs:scale = ${USDExport._BuildVector2(repeat)}
                float2 inputs:translation = ${USDExport._BuildVector2(offset)}
                float2 outputs:result
            }
            def Shader "Texture_${texture.uniqueId}_${mapType}"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @textures/Texture_${id}.png@
                float2 inputs:st.connect = </Materials/Material_${material.uniqueId}/Transform2d_${mapType}.outputs:result>
                ${color !== undefined ? "float4 inputs:scale = " + USDExport._BuildColor4(color) : ""}
                token inputs:sourceColorSpace = "${"sRGB" /* TODO CHECK THIS */}"
                token inputs:wrapS = "${WRAPPINGS[texture.wrapU] /* TODO CHECK THIS */}"
                token inputs:wrapT = "${WRAPPINGS[texture.wrapV] /* TODO CHECK THIS */}"
                float outputs:r
                float outputs:g
                float outputs:b
                float3 outputs:rgb
                ${material.needAlphaTesting() ? "float outputs:a" : "" /* TODO NEED A BETTER CHECK */}
    
            }`;
        }

        if (!material.cullBackFaces) {
            Tools.Warn(`USDExport: USDZ does not support double sided materials, target mat: ${material.name}`);
        }

        if (material.albedoTexture !== null) {
            inputs.push(`${pad}color3f inputs:diffuseColor.connect = </Materials/Material_${material.uniqueId}/Texture_${material.albedoTexture.uniqueId}_diffuse.outputs:rgb>`);

            if (material.useAlphaFromAlbedoTexture) {
                inputs.push(`${pad}float inputs:opacity.connect = </Materials/Material_${material.uniqueId}/Texture_${material.albedoTexture.uniqueId}_diffuse.outputs:a>`);
            } else if (material.needAlphaTesting()) {
                inputs.push(`${pad}float inputs:opacity.connect = </Materials/Material_${material.uniqueId}/Texture_${material.albedoTexture.uniqueId}_diffuse.outputs:a>`);
                inputs.push(`${pad}float inputs:opacityThreshold = ${material.alphaCutOff}`);
            }

            samplers.push(buildTexture(material.albedoTexture as Texture, "diffuse", material.albedoColor));
        } else {
            inputs.push(`${pad}color3f inputs:diffuseColor = ${USDExport._BuildColor(material.albedoColor)}`);
        }

        if (material.emissiveTexture !== null) {
            inputs.push(
                `${pad}color3f inputs:emissiveColor.connect = </Materials/Material_${material.uniqueId}/Texture_${material.emissiveTexture.uniqueId}_emissive.outputs:rgb>`
            );
            samplers.push(buildTexture(material.emissiveTexture as Texture, "emissive"));
        } else if (material.emissiveColor) {
            inputs.push(`${pad}color3f inputs:emissiveColor = ${USDExport._BuildColor(material.emissiveColor)}`);
        }

        if (material.bumpTexture !== null) {
            inputs.push(`${pad}normal3f inputs:normal.connect = </Materials/Material_${material.uniqueId}/Texture_${material.bumpTexture.uniqueId}_normal.outputs:rgb>`);
            samplers.push(buildTexture(material.bumpTexture as Texture, "normal"));
        }

        if (material.metallicTexture !== null) {
            const maps = await breakApartMetallicRoughnessAo(material.metallicTexture as Texture);

            inputs.push(`${pad}float inputs:roughness.connect = </Materials/Material_${material.uniqueId}/Texture_${maps.roughness.uniqueId}_roughness.outputs:g>`);
            samplers.push(buildTexture(maps.roughness, "roughness"));

            inputs.push(`${pad}float inputs:metallic.connect = </Materials/Material_${material.uniqueId}/Texture_${maps.metallic.uniqueId}_metallic.outputs:b>`);
            samplers.push(buildTexture(maps.metallic, "metallic"));

            inputs.push(`${pad}float inputs:occlusion.connect = </Materials/Material_${material.uniqueId}/Texture_${maps.ao.uniqueId}_occlusion.outputs:r>`);
            samplers.push(buildTexture(maps.ao, "occlusion"));
        } else {
            inputs.push(`${pad}float inputs:roughness = ${material.roughness}`);
            inputs.push(`${pad}float inputs:metallic = ${material.metallic}`);
        }

        if (material.opacityTexture !== null) {
            inputs.push(`${pad}float inputs:opacity.connect = </Materials/Material_${material.uniqueId}/Texture_${material.opacityTexture.uniqueId}_opacity.outputs:r>`);
            inputs.push(`${pad}float inputs:opacityThreshold = 0.0001`);
            samplers.push(buildTexture(material.opacityTexture as Texture, "opacity"));
        } else {
            inputs.push(`${pad}float inputs:opacity = ${material.alpha}`);
        }

        if (material.isMetallicWorkflow()) {
            inputs.push(`${pad}float inputs:clearcoat = ${material.clearCoat.isEnabled ? 1.0 : 0.0}`);
            inputs.push(`${pad}float inputs:clearcoatRoughness = ${material.clearCoat.isEnabled ? material.clearCoat.intensity : 0.0}`);
            inputs.push(`${pad}float inputs:ior = ${material.subSurface?.indexOfRefraction ?? 1.5}`);
        }

        return `
        def Material "Material_${material.uniqueId}"
        {
            def Shader "PreviewSurface"
            {
                uniform token info:id = "UsdPreviewSurface"
    ${inputs.join("\n")}
                int inputs:useSpecularWorkflow = 0
                token outputs:surface
            }
    
            token outputs:surface.connect = </Materials/Material_${material.uniqueId}/PreviewSurface.outputs:surface>
    
    ${samplers.join("\n")}
        }
    `;
    }

    private static _BuildColor(color: Color3) {
        return `(${color.r}, ${color.g}, ${color.b})`;
    }

    private static _BuildColor4(color: Color3) {
        return `(${color.r}, ${color.g}, ${color.b}, 1.0)`;
    }

    private static _BuildVector2(vector: Vector2) {
        return `(${vector.x}, ${vector.y})`;
    }

    private static _BuildUSDFileAsString(dataToInsert: string) {
        let output = USDExport._BuildHeader();
        output += dataToInsert;
        return USDExport._LastOptions.strToU8(output);
    }

    /**
     * Converts a Babylon Texture to an HTML Image Element.
     * @param texture can be a Texture or DynamicTexture
     * @returns a promise with the HTML Image Element or the DynamicTexture directly.
     */
    private static async _TextureToImage(texture: Texture | DynamicTexture): Promise<HTMLImageElement | DynamicTexture> {
        if (texture.getClassName() === "DynamicTexture") {
            return texture as DynamicTexture;
        }

        return new Promise((resolve, reject) => {
            const image = new Image();
            image.crossOrigin = "anonymous";
            image.onload = () => {
                resolve(image);
            };
            image.onerror = reject;

            const dataBlobCheck = (texture.url ?? "").substring(0, 5);

            if (dataBlobCheck === "data:") {
                image.src = (texture.url ?? "").substring(5);
            } else {
                image.src = texture.url ?? "";
            }
        });
    }

    /**
     * Converts an Image to a Canvas element, or returns the DynamicTexture's canvas directly.
     * @param image can be a HTMLImageElement or DynamicTexture
     * @returns the image or texture as a canvas element.
     */
    private static _ImageToCanvas(image: any, flipY: boolean): HTMLCanvasElement {
        if (image?.getClassName && image.getClassName() === "DynamicTexture") {
            return image._canvas;
        }
        if (
            (typeof HTMLImageElement !== "undefined" && image instanceof HTMLImageElement) ||
            (typeof HTMLCanvasElement !== "undefined" && image instanceof HTMLCanvasElement) ||
            (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap)
        ) {
            const scale = 1024 / Math.max(image.width, image.height);

            const canvas = document.createElement("canvas");
            canvas.width = image.width * Math.min(1, scale);
            canvas.height = image.height * Math.min(1, scale);

            const context = canvas.getContext("2d");
            // TODO: We should be able to do this in the UsdTransform2d?

            if (context) {
                if (flipY === true) {
                    context.translate(0, canvas.height);
                    context.scale(1, -1);
                }
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
            } else {
                throw new Error("USDExport: No valid canvas context. Unable to process texture.");
            }

            return canvas;
        } else {
            throw new Error("USDExport: No valid image data found. Unable to process texture.");
        }
    }
}
