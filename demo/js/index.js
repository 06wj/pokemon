var mainContainerElem = document.querySelector('.mainContainer');
var listContainerElem = document.querySelector('#listContainer');
var stageContainerElem = document.querySelector('#stageContainer');
var modelViewerContainerElem = document.querySelector('#modelViewerContainer');
var closeBtnElem = document.querySelector('#closeBtn');
var nextBtnElem = document.querySelector('#nextBtn');
var loadingElem = document.querySelector('#loading');
var titleElem = document.querySelector('#title');
var camera, stage, ticker, orbitControls, glTFLoader, model;
var gui;

function initList(){
    models.forEach(function(modelInfo, index){
        if (modelInfo.disable) {
            return;
        }
        var name = modelInfo.name;
        var id = modelInfo.id;
        var elem = document.createElement('div');
        var modelPath = `../models/${id}/`;
        elem.className = 'modelContainer';
        elem.setAttribute('data-id', id);
        elem.innerHTML = `
            <div data-id='${id}' class='modelIcon' style='background-position:${-(148 + 4)/2*(index%13)}px ${-(125 + 4)/2*(Math.floor(index/13)) + 0.5}px;background-size:988px 838px;background-image:url(./img/icon.jpg);width:74px;height:63px;'></div>
            <div data-id='${id}' class='modelInfo'>${id} ${name}</div>
        `;
        listContainerElem.appendChild(elem);
    });

    listContainerElem.onclick = function(e){
        var id = e.target.getAttribute('data-id');
        if (id) {
            showModel(id);
        }
    };
}

function initStage(){
    camera = new Hilo3d.PerspectiveCamera({
        aspect: innerWidth / innerHeight,
        far: 100,
        near: 0.1,
        z: 3
    });

    stage = new Hilo3d.Stage({
        container: stageContainer,
        camera: camera,
        clearColor: new Hilo3d.Color(0.4, 0.4, 0.4),
        width: innerWidth,
        height: innerHeight
    });

    ticker = new Hilo3d.Ticker(60);
    ticker.addTick(stage);
    ticker.addTick(Hilo3d.Tween);
    ticker.addTick(Hilo3d.Animation);
    ticker.start();

    orbitControls = new OrbitControls(stage, {
        isLockMove:true,
        isLockZ:true,
        rotationXLimit:true
    });

    glTFLoader = new Hilo3d.GLTFLoader();

    closeBtnElem.onclick = function(){
        hideModel();
    }

    nextBtnElem.onclick = function(){
        showNext();
    }

    initGui();
}

function hideModel(){
    modelViewerContainerElem.style.display = 'none';
    listContainerElem.style.display = 'flex';

    // reset resource
    Hilo3d.BasicLoader.cache.clear();
    stage.destroy();
    stage.matrix.identity();
    orbitControls.reset();

    titleElem.innerHTML = 'Pokémon Viewer';
    location.hash = '';
}

function onShowModelError(){
    alert('Someting Error!');
    hideModel();
}

function showModel(id){
    modelViewerContainerElem.style.display = 'block';
    listContainerElem.style.display = 'none';

    loadingElem.style.display = 'block';
    titleElem.innerHTML = `${id} ${modelDict[id].name}`;

    var glTFUrl = `../models/${id}/glTF/model.gltf`;
    glTFLoader.load({
        src: glTFUrl,
        isUnQuantizeInShader:false
    }).then(function(model) {
        loadingElem.style.display = 'none';
        try{
            initModel(model, modelDict[id]);
        } catch(e){
            onShowModelError();
        }
    }, onShowModelError);
    location.hash = id;
}

var defaultRoughness = 0.1;
if (utils.keys.roughness) {
    defaultRoughness = parseFloat(utils.keys.roughness);
}

var defaultMetallic = 0.1;
if (utils.keys.metallic) {
    defaultMetallic = parseFloat(utils.keys.metallic);
}

function initModel(model, modelInfo){
    window.model = model;
    stage.addChild(model.node);

    if (modelInfo.rotation) {
        model.node.rotationX = modelInfo.rotation;
    }

    model.node.rotationY = 20;

    model.materials.forEach(function(material){
        material.depthMask = true;
    });

    var bounds = model.node.getBounds();

    var modelHasLight = !!(model.lights && model.lights.length);
    var modelHasCamera = !!(model.cameras && model.cameras.length);

    const scale = 1.5/Math.max(bounds.width, bounds.height, bounds.depth);
    model.node.setPosition(-bounds.x * scale, -bounds.y * scale, -bounds.z * scale);
    model.node.setScale(scale);

    utils.loadEnvMap(function(data) {
        model.materials.forEach(function(material) {
            material.brdfLUT = data.brdfLUT;
            material.diffuseEnvMap = data.diffuseEnvMap;
            material.specularEnvMap = data.specularEnvMap;
            material.isDirty = true;
        });

        if (modelInfo.fire) {
            model.meshes.forEach(function(mesh){
                var src;
                if(mesh.material.baseColorMap) {
                    var baseColorMap = mesh.material.baseColorMap;
                    src = baseColorMap.src || '';
                    if (src.indexOf('FireCore') > -1) {
                        mesh.material = new Hilo3d.ShaderMaterial({
                            shaderCacheId: "FireCore",
                            needBasicUnifroms: false,
                            needBasicAttributes: false,
                            fireCoreTexture: baseColorMap,
                            side:Hilo3d.constants.FRONT_AND_BACK,
                            uniforms:{
                                u_modelViewProjectionMatrix:'MODELVIEWPROJECTION',
                                u_fireCoreTexture:{
                                    get(mesh, material, programInfo) {
                                        return Hilo3d.semantic.handlerTexture(material.fireCoreTexture, programInfo.textureIndex);
                                    }
                                },
                                u_time:{
                                    get:function(mesh, material, programInfo){
                                        return new Date().getTime() - 1577099833000;
                                    }
                                }
                            },
                            attributes:{
                                a_position: 'POSITION',
                                a_texcoord0:'TEXCOORD_0'
                            },
                            fs:`
                                precision HILO_MAX_FRAGMENT_PRECISION float;
                                varying vec2 v_texcoord0;
                                uniform sampler2D u_fireCoreTexture;
                                uniform float u_time;
                             
                                void main(void) {
                                    float uOffset = u_time * 0.00;
                                    float vOffset = u_time * 0.001;
                                    vec4 fireCore = texture2D(u_fireCoreTexture, vec2(v_texcoord0.x + uOffset, v_texcoord0.y + vOffset));
                                    if (fireCore.r < 0.5) {
                                        discard;
                                    }
                                    gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
                                }
                            `,
                            vs:`
                                precision HILO_MAX_VERTEX_PRECISION float;
                                attribute vec3 a_position;
                                attribute vec2 a_texcoord0;
                                uniform mat4 u_modelViewProjectionMatrix;
                                varying vec2 v_texcoord0;

                                void main(void) {
                                    vec4 pos = vec4(a_position, 1.0);
                                    gl_Position = u_modelViewProjectionMatrix * pos;
                                    v_texcoord0 = a_texcoord0;
                                }
                            `
                        });
                    } else if (src.indexOf('FireSten') > -1) {
                        mesh.material = mesh.material = new Hilo3d.ShaderMaterial({
                            shaderCacheId: "FireSten",
                            needBasicUnifroms: false,
                            needBasicAttributes: false,
                            fireCoreTexture: baseColorMap,
                            transparent:true,
                            uniforms:{
                                u_modelViewProjectionMatrix:'MODELVIEWPROJECTION',
                                u_fireSten:{
                                    get(mesh, material, programInfo) {
                                        return Hilo3d.semantic.handlerTexture(material.fireCoreTexture, programInfo.textureIndex);
                                    }
                                },
                                u_time:{
                                    get:function(mesh, material, programInfo){
                                        return new Date().getTime() - 1577099833000;
                                    }
                                }
                            },
                            attributes:{
                                a_position: 'POSITION',
                                a_texcoord0:'TEXCOORD_0'
                            },
                            fs:`
                                precision HILO_MAX_FRAGMENT_PRECISION float;
                                varying vec2 v_texcoord0;
                                uniform sampler2D u_fireSten;
                                uniform float u_time;
                                void main(void) {
                                    float gradient_start = 1.0;
                                    vec2 gradient = vec2(0, -1.0);
                                    vec4 fireSten = texture2D(u_fireSten, v_texcoord0);
                                    vec3 col1 = vec3(1.0, 0.0, 0.0);
                                    vec3 col2 = vec3(1.0, 1.0, 0.0);
                                    vec3 col = col1 + (col2 - col1) * max(0.0, min(gradient_start+dot(v_texcoord0, gradient)+(fireSten.x-0.5)*0.1, 1.0));
                                    gl_FragColor = vec4(col, .2);
                                }
                            `,
                            vs:`
                                precision HILO_MAX_VERTEX_PRECISION float;
                                attribute vec3 a_position;
                                attribute vec2 a_texcoord0;
                                uniform mat4 u_modelViewProjectionMatrix;
                                varying vec2 v_texcoord0;

                                void main(void) {
                                    vec4 pos = vec4(a_position, 1.0);
                                    gl_Position = u_modelViewProjectionMatrix * pos;
                                    v_texcoord0 = a_texcoord0;
                                }
                            `
                        });
                    }
                }
            });      
        }

        var skyBox = new Hilo3d.Mesh({
            geometry: new Hilo3d.BoxGeometry(),
            material: new Hilo3d.BasicMaterial({
                lightType: 'NONE',
                side: Hilo3d.constants.BACK,
                diffuse: data.specularEnvMap
            })
        }).addTo(stage);
        skyBox.setScale(20);

        var directionLight = new Hilo3d.DirectionalLight({
            x:1,
            y:1,
            z:5,
            color:new Hilo3d.Color(1, 1, 1),
            direction:new Hilo3d.Vector3(-1, -1, 0)
        }).addTo(stage);
    });

    resetMaterial();
}

function resetMaterial(){
    if (model && gui) {
        model.materials.forEach(function(material){
            material.metallic = gui.material.metallic;
            material.roughness = gui.material.roughness;
        });
    }
}

function initGui(){
    gui = new dat.GUI({
        autoPlace: false
    });
    gui.material = {
        metallic: defaultMetallic,
        roughness: defaultRoughness
    };
    gui.add(gui.material, 'metallic', 0, 1).onChange(resetMaterial);
    gui.add(gui.material, 'roughness', 0, 1).onChange(resetMaterial);
    modelViewerContainerElem.appendChild(gui.domElement);
}

if (location.hash.split('#')[1]){
    initStage();
    showModel(location.hash.split('#')[1]);
    initList();
} else {
    initList();
    initStage();
}

function showNext(){
    var id = parseInt(location.hash.split('#')[1]) + 1;
    if (id > models.length) {
        id = 1;
    }

    if (id < 10) {
        id = '00' + id;
    } else if (id < 100) {
        id = '0' + id;
    }

    var info = modelDict[id];
    console.log(info);
    if (!info || info.disable) {
        location.hash = "#" + id;
        setTimeout(() => {
            showNext();
        }, 0);
        return;
    }

    hideModel();
    showModel(id);
}