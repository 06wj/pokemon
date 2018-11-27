var containerElem = document.querySelector('#listContainer');
models.forEach(function(modelInfo){
    var name = modelInfo.name;
    var id = modelInfo.id;
    var elem = document.createElement('a');
    var modelPath = `../models/${id}/`;
    elem.className = 'modelContainer';
    elem.href = `https://hiloteam.github.io/Hilo3d/examples/glTFViewer/index.html?url=https://06wj.github.io/pokemon/models/${id}/glTF/model.gltf`;
    elem.target = '_blank';
    elem.innerHTML = `
        <img src="./${modelPath}icon.png" width="74" height="63" />
        <div class='modelInfo'>${id} ${name}</div>
    `;
    containerElem.appendChild(elem);
});