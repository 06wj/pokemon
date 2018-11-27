var containerElem = document.querySelector('#listContainer');
models.forEach(function(modelInfo){
    var name = modelInfo.name;
    var id = modelInfo.id;
    var elem = document.createElement('div');
    var modelPath = `../models/${id}/`;
    elem.className = 'modelContainer';
    elem.setAttribute('data-id', id);
    elem.innerHTML = `
        <img src="./${modelPath}icon.png" width="74" height="63" />
        <div class='modelInfo'>${id} ${name}</div>
    `;
    containerElem.appendChild(elem);
});