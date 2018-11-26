const fs = require('fs-extra')
const download = require('download');
const colors = require('colors');

const models = require('./model.json');
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

async function loadModel(modelInfo) {
    const {
        name,
        downloadUrl,
        icon
    } = modelInfo;

    const nameResult = name.match(/#([\d]+)\s([\w\.\s♀♂]+)/);
    const realName = nameResult[2];
    const modelNum = nameResult[1];
    const finalModelPath = `origin_models/${name}/`;
    
    const iconExist = await fs.pathExists(`${finalModelPath}icon.png`);
    if (!iconExist) {
        await download(icon, finalModelPath, {
            filename:'icon.png'
        });
    }

    const modelExist = await fs.pathExists(`${finalModelPath}model`);
    if (!modelExist) {
        console.log(`downloadStart:${name}`.info);
        await download(downloadUrl, finalModelPath, {
            filename:'model',
            extract:true
        });
        console.log(`downloadEnd:${name}`.info);

        let realPath = `${finalModelPath}Pokemon XY/${realName}/`;
        if(await fs.pathExists(realPath)){
            console.log(`copy...${name}`);
            await fs.copy(realPath, `${finalModelPath}model/`)
            await fs.remove(`${finalModelPath}Pokemon XY`);
        }

        realPath = `${finalModelPath}${realName}/`;
        if(await fs.pathExists(realPath)){
            console.log(`copy...${name}`);
            await fs.copy(realPath, `${finalModelPath}model/`)
            await fs.remove(realPath);
        }

        realPath = `${finalModelPath}${modelNum}. ${realName}/`;
        if(await fs.pathExists(realPath)){
            console.log(`copy...${name}`);
            await fs.copy(realPath, `${finalModelPath}model/`)
            await fs.remove(realPath);
        }
    } else {
        
    }

    
}

async function loadModels() {
    await Promise.all(models.map(async (modelInfo) => {
        await loadModel(modelInfo);
    }));

    console.log('All models load complete!'.info);
};


loadModels();