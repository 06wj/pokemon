const fs = require('fs-extra')
const execa = require('execa');
const models = require('./model.json');
const colors = require('colors');
colors.setTheme({
    silly: 'rainbow',
    input: 'grey',
    verbose: 'cyan',
    prompt: 'grey',
    info: 'green',
    data: 'grey',
    help: 'cyan',
    warn: 'yellow',
    debug: 'blue',
    error: 'red'
});

const blenderPath = '/Applications/Blender/blender.app/Contents/MacOS/blender';
const pythonPath = '/Users/06wj/Documents/github/pokemon/tools/convert.py';

async function getModelPath(name) {
    const nameResult = name.match(/#([\d]+)\s(['\w\.\s♀♂]+)/);
    const realName = nameResult[2].replace('♀', 'F').replace('♂', 'M').replace('. ', '');
    const modelNum = nameResult[1];

    const postfixes = ['', '_ColladaMax', '_OpenCollada', '_F', '_M', 'F_ColladaMax', 'M_ColladaMax', 'F_OpenCollada', 'M_OpenCollada', '_00'];
    for(let i = 0;i < postfixes.length; i++) {
        const modelPath = `origin_models/${name}/model/${realName}${postfixes[i]}.DAE`;
        if(await fs.pathExists(modelPath)){
            return modelPath;
        }
    }

    // 81
    const modelNumPath = `origin_models/${name}/model/pm0${modelNum}_00.dae`;
    if (await fs.pathExists(modelNumPath)) {
        return modelNumPath;
    }

    return '';
}

const error_num = ['015', '051', '081', '093', '111', '120'];

async function convertModel(modelInfo){
    const {
        name,
        downloadUrl,
        icon
    } = modelInfo;

    const nameResult = name.match(/#([\d]+)\s([\w\.\s♀♂]+)/);
    const realName = nameResult[2];
    const modelNum = nameResult[1];

    const modelPath = (await getModelPath(name)).replace(/#/g, '\\#').replace(/ /g, '\\ ');
    if (!modelPath) {
        console.log(name);
    } 
    
    const exportPath = `models/${modelNum}/`;
    await fs.copy(`origin_models/${name}/icon.png`, `${exportPath}icon.png`);

    const exportGLTFPath = `models/${modelNum}/glTF/`;
    if (! await fs.pathExists(`${exportGLTFPath}model.gltf`)){
        fs.ensureDir(`${exportGLTFPath}`);
        const convertPath = `${exportGLTFPath}origin.gltf`;
        
        if (!await fs.pathExists(convertPath)) {
            const cmd = `${blenderPath} -b -P ${pythonPath} -- ${modelPath} ${convertPath}`;
            console.log(`convertStart: ${modelNum}`);
            await execa.shell(cmd);


            // amc start
            if (error_num.indexOf(modelNum) < 0) {
                console.log(`amcStart: ${modelNum}`);
                await execa.shell(`amc-glTF -i ${convertPath} -o ${exportGLTFPath}model.gltf`);
            }
            
            if (await fs.pathExists(`${exportGLTFPath}model.gltf`)){
                await fs.remove(`${exportGLTFPath}/origin.gltf`);
                await fs.remove(`${exportGLTFPath}/origin.bin`);
            } else {
                console.log(`amcFaild: ${modelNum}`.warn);
            }
        }
    }
}


async function convertModels(){
    for (let i = 0; i < models.length; i++) {
        try{
            await convertModel(models[i]);
        } catch(e) {
            console.log(`convertError: ${i}`.error);
        }
    }

    console.log('All models convert complete!');
}

convertModels();

// 13 14

