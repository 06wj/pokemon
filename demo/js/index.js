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
    Hilo3d.semantic.TIME = {
        startTime:new Date().getTime(),
        get:function(){
            return new Date().getTime() - this.startTime;
        }
    }

    camera = new Hilo3d.PerspectiveCamera({
        aspect: innerWidth / innerHeight,
        far: 100,
        near: 0.1,
        z: 3
    });

    stage = new Hilo3d.Stage({
        container: stageContainer,
        camera: camera,
        clearColor: new Hilo3d.Color(0, 0, 0),
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
        isUnQuantizeInShader:false,
        isLoadAllTextures: true
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

var defaultRoughness = 0.64;
if (utils.keys.roughness) {
    defaultRoughness = parseFloat(utils.keys.roughness);
}

var defaultMetallic = 1;
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

    var skyBox = new Hilo3d.Mesh({
        geometry: new Hilo3d.BoxGeometry(),
        material: new Hilo3d.BasicMaterial({
            lightType: 'NONE',
            side: Hilo3d.constants.BACK,
            diffuse: new Hilo3d.Color(1, 1, 1)
        })
    }).addTo(stage);
    skyBox.setScale(20);

    utils.loadEnvMap(function(data) {
        model.materials.forEach(function(material) {
            material.brdfLUT = data.brdfLUT;
            material.diffuseEnvMap = data.diffuseEnvMap;
            material.specularEnvMap = data.specularEnvMap;
            material.isDirty = true;
        });

        if (modelInfo.fire) {
            model.meshes.forEach(function(mesh){
                var material = mesh.material;
                if (material.name.indexOf('fireCore') > -1){
                    material.renderOrder = -2;
                } else if(material.name.indexOf('fireSten') > -1){
                    material.depthMask = false;
                    material.renderOrder = -1;
                }
            });      
        }

        skyBox.material.diffuse = data.specularEnvMap;
        skyBox.material.isDirty = true;

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
