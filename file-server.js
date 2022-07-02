const express = require('express');
const shrinkRay = require('shrink-ray-current');
const imagemin = require('imagemin');
const imagejpg = require('imagemin-mozjpeg');
const imagegif = require('imagemin-gifsicle');
const imagepng = require('imagemin-pngquant');
const os = require('os');
const mkdirp = require('mkdirp');
const fs = require('graceful-fs');
const path = require('path');
const yazl = require('yazl');
const sharp = require('sharp');

const FILE_CREATION_MODE = 0o600;
const DIR_CREATION_MODE = 0o700;

const logFd = fs.openSync('./log.txt','as',FILE_CREATION_MODE);
const IS_HTTPS = false;
const PORT = 80;
const TIME_BETWEEN_PASSWORD_CHECK = 5 * 60000;
const TIME_TO_PURGE_ZIPS = 60 * 60000 * 24;

const USE_LOSSY_COMPRESSION = true;

const COMPRESSION_CACHE_SIZE = '512mb';
const COMPRESSION_MIN_SIZE = '64kb';
const COMPRESSION_ZLIB_LEVEL = 6;//see https://blogs.akamai.com/2016/02/understanding-brotlis-potential.html
const COMPRESSION_BROTLI_LEVEL = 5;

let httpModule;
const app = express();
if (IS_HTTPS) {
  const HTTPS_KEY = fs.readFileSync('./https.key');
  const HTTPS_CERT = fs.readFileSync('./https.cert');

  const crypto = require('crypto');
  let consts = crypto.constants;
  
  const httpsOptions = {key: HTTPS_KEY, cert: HTTPS_CERT,
                        secureOptions: consts.SSL_OP_NO_SSLv2 |
                                       consts.SSL_OP_NO_SSLv3 |
                                       consts.SSL_OP_NO_TLSv1 |
                                       consts.SSL_OP_NO_TLSv1_11};
  const https = require('https');
  httpModule = https.createServer(httpsOptions, app);
} else {
  const http = require('http');
  httpModule = http.createServer(app);
}
httpModule.listen(PORT, '0.0.0.0', () => {
  log.info('Listening on '+PORT);
  closeOnSignals(httpModule, ['SIGTERM', 'SIGINT', 'SIGHUP']);
});

const HTML_STYLE = '.main {text-align: center; vertical-align: middle; position: relative; display: inline-block; padding: 10px}'
  +' .text {display:block; float:none; margin:auto; position:static; max-width: 15em; word-wrap: break-word}'
  +' .dl {text-align: center;border: 3px solid black;border-radius: 16px;display: block;}'
  +' .dlcenter {margin-left: auto; margin-right:auto; width: 30%}';

const START_LISTING_HTML='<!DOCTYPE html><html><head><style>'+HTML_STYLE+'</style><link rel="stylesheet" href="/assets/fa/css/font-awesome.min.css"></head><link rel="icon" type="image/png" sizes="64x64" href="/favicon.png"><body ';
const END_LISTING_HTML='</div></body></html>';

const dirMap = {};
const FILE_DIR = path.join(__dirname,'./file-dir');
mkdirp.sync('./file-dir');
mkdirp.sync('./thumbnails');
mkdirp.sync('./temp');

class Logger {
  getPrefix(type){
    return `[${new Date(Date.now()).toUTCString()} - ${type}] `; 
  }
  info(msg){
    let line = this.getPrefix('info')+msg;
    fs.write(logFd,line+'\n',function(){});
  }
  warn(msg){
    let line = this.getPrefix('warn')+msg;
    fs.write(logFd,line+'\n',function(){});
  }
}
const log = new Logger();


function addWatchers(folder) {
  return false;
  log.info('addwatcher to '+folder);
  fs.readdir(folder, {withFileTypes: true}, function(err, files) {
    if (err) {
      log.warn('Error in addWatchers, '+err.message);
    } else {
      files.forEach(function(file){
        if (file.isDirectory()) {
          addWatchers(path.join(folder,file.name));
        }
      });
    }
  });
  dirMap[folder] = fs.watch(folder,{persistent: false},function(event, name) {
    //name may be folder
    if (event == 'rename') {
      setTimeout(function(){
        let originalPath = path.join(folder, name);
        fs.stat(originalPath, function(err, stat) {
          let lossyPath = originalPath.replace(FILE_DIR,path.resolve('./lossy'));
          log.info('dealing with lossy for '+originalPath+' and '+lossyPath);
          if (!err) {
            makeLossyImage(originalPath, lossyPath, false);
          } else {
            fs.unlink(lossyPath, function(err) {
              if (err) {
                log.warn('Could not delete path='+lossyPath);
              }
            });
          }
        });
      },500);
    }
  });
}
addWatchers(FILE_DIR);

class PasswordStore {
  constructor() {
    this.updateList();
    setInterval(()=> {
      this.updateList();
    },TIME_BETWEEN_PASSWORD_CHECK);
  }
  updateList() {
    try {
      this.map = JSON.parse(fs.readFileSync('./passwords.json',{encoding: 'utf8', flag: 'r'}));
    } catch (e) {
      //oh well
    }
  }
  
  //starts with /inf, for example
  hasAccess(path, pass) {
    const parts = path.split('/');
    try {
      const result = this.map[parts[2]];
      return !result || pass == result;
    } catch (e) {
      return false;
    }
  }
}
const passStore = new PasswordStore();


function logReqs(req,res,next) {
  log.info(`Req to ${req.originalUrl} from ${req.ip}`);
  next();
};

function forbidden(req,res,next) {
  if (req.originalUrl.includes('//')) {
    res.status(400).send('<h1>Malformed url</h1>');
  }
  if (req.originalUrl.includes('..')) {
    res.status(400).send('<h1>Relative paths not supported</h1>');
  } else {
    next();
  }
}

function checkExpire(req,res,next) {
  try {
    if (req.path.substring(1).split('/')[0] == 'inf') {
      next();
    } else {
      //TODO do expiration checks based on the hour in dirname and the timestamp of next dir/file
      res.status(400).send('<h1>Not yet implemented</h1>');
    }
  } catch (e) {
    log.warn(`Error on checking expiration: ${e.message}`);
    res.status(500).send('<h1>Internal server error</h1>');
  }
}

function checkPassword(req,res,next) {
  try {
    const pathParts = req.path.substring(1).split('/');
    let pathPortion;
    for (let i = 0; i < pathParts.length; i++) {
      pathPortion = '/'+pathParts[i];
      if (pathPortion.startsWith('/')) {
        pathPortion = pathPortion.substring(1);
      }
      let pass = passStore.map[pathPortion];
      if (pass) {
        if (req.query.pass == pass) {
          next();
          return;
        } else {
          log.warn(`Bad credentials given for ${req.baseUrl}`);
          res.status(403).send('<h1>Invalid credentials</h1>');
          return;
        }
      }
    }
    next(); //No password protection found, proceed.
  } catch (e) {
    log.warn(`Error checking password: ${e.message}`);
    res.status(500).send('<h1>Internal server error</h1>');
  }
}

class YazlArchiver {
  constructor(baseDir, destination) {
    this.zipfile = new yazl.ZipFile();
    this.pipe = this.zipfile.outputStream.pipe(fs.createWriteStream(destination+'.temp'));
    this.baseDir = baseDir;
    this.filesAdded = 0;
    this.dirsAdded = 0;
    this.archiveSize = -1;
    this.destination = destination;
    this.finished = false;
  }

  addFile(filePath) {
    //filepath is absolute, zippath is relative to starting folder
    this.zipfile.addFile(filePath, this.getZipPath(filePath), {mode:FILE_CREATION_MODE});
    this.filesAdded = (this.filesAdded + 1)|0;
  }
  
  addDirectory(filePath) {
    this.dirsAdded = (this.dirsAdded + 1)|0;
  }
  
  getZipPath(filePath) {
    // /foo/bar/baz becomes /bar/baz in archive if inputDir=foo
    return filePath.substring(this.baseDir.length+1);
  }
  
  finalizeArchive() {
    return new Promise((resolve, reject)=> {
      this.pipe.on('close', ()=> {
        try {
          let destStat;
          try {
            destStat = fs.statSync(this.destination);
          } catch (e) {
            if (e.code != 'ENOENT') {
              throw e;
            }
          }
          if (!destStat) {
            //file didnt exist, good to go
          } else {
            fs.unlinkSync(this.destination);
          }
          fs.renameSync(this.destination+'.temp', this.destination);
          this.finished = true;
          resolve();
        } catch (e) {
          log.warn(`Could not rename temp file to final destination (${this.destination}), Error=${e.message}`);
          reject();
        }
      });
      //finalSize can be given before pipe close, but may be -1 safely due to circumstances (read yazl doc)
      this.zipfile.end({},(finalSize)=> {
        this.archiveSize = finalSize;
      });
    });
  }

  //on failure, remove any temp files
  failureCleanup() {
    return new Promise((resolve, reject)=> {
      log.info(`Performing cleanup of temp file (${this.destination+'.temp'})`);
      this.pipe.on('close',()=> {
        try {
          fs.unlinkSync(this.destination+'.temp');
          resolve();
        } catch (e) {
          log.warn(`Could not perform cleanup of temp file (${this.destination+'.temp'}), Error=${e.message}`);
          resolve();
        }
      });      
      this.zipfile.end();
    });
  }

  getSummary() {
    return {
      filesAdded: this.filesAdded,
      dirsAdded: this.dirsAdded,
      destinaton: this.destination,
      finished: this.finished,
      archiveSize: this.archiveSize
    }
  }
}

function packageRecursively(topDirectory, archiver) {
  let stop = false;

  return new Promise((resolve, reject)=> {
    let innerLoop = function(directory, successCallback) {
      fs.readdir(directory,(err, files)=> {
        if (err) {
          //maybe dir doesnt exist, bubble up
          reject(err);
        } else {
          if (files.length == 0) {
            if (directory == topDirectory) {
              reject(new Error(`No files in requested directory (${topDirectory}`));
            } else {
              successCallback();
            }
          } else {
            let filesComplete = 0;
            files.forEach((file)=> {
              if (!stop) {
                //this will be a full path
                let filePath = path.join(directory,file);
                fs.stat(filePath,(err,stats)=> {
                  if (err) {
                    stop = true;
                    reject(err);
                  } else {
                    if (stats.isDirectory()) {
                      //loop
                      archiver.addDirectory(filePath);
                      innerLoop(filePath,()=> {
                        filesComplete++;
                        if (filesComplete == files.length) {
                          if (directory == topDirectory) {
                            resolve();
                          } else {
                            successCallback();
                          }
                        }
                      });
                    } else {
                      archiver.addFile(filePath);
                      filesComplete++;
                      if (filesComplete == files.length) {
                        if (directory == topDirectory) {
                          resolve();
                        }
                        else {
                          successCallback();
                        }
                      }
                      /*
                      if (err) {
                        stop = true;
                        reject (err);
                      }
                      */
                    }
                  }
                });
              }
            });
          }        
        }
      });
    };

    
    innerLoop(topDirectory, ()=> {resolve();});
  });
}



function doZip(req,res,next) {
  if (req.query.zip != '1') {
    next();
  } else {
    //req.path includes slash
    let reqPath = decodeURIComponent(req.path);
    reqPath = reqPath.endsWith('/') ? reqPath.substring(0,reqPath.length-1) : reqPath;
    //TODO security still incomplete, prevent this
    if (reqPath == "/inf") {
      res.status(400).send("<h1>Cannot download root</h1>");
    }
    const source = `./file-dir${reqPath}`;
    const destination = `./temp${reqPath}.zip`;
    
    
    mkdirp(destination.substring(0,destination.lastIndexOf('/')),{mode:DIR_CREATION_MODE}).then(()=> {
      fs.access(destination, fs.constants.R_OK, function(err) {
        if (err) {
          //probably time to create
          //TODO get rid of the space, I messed up somewhere else.
          const archiver = new YazlArchiver(`./file-dir/ `, destination);
          //package everything
          packageRecursively(source, archiver).then(function() {
            archiver.finalizeArchive().then(function() {
              log.info(`Serving zip for ${reqPath} at  ${destination}`);
              res.sendFile(path.resolve(destination));
              setTimeout(function(){
                log.info(`Cleanup. Deleting zip ${destination}`);
                fs.unlink(destination,function(err){
                  if (err) {
                    log.warn(`Unable to cleanup ${destination}. Is it already gone? ${err.message}`);
                  }
                });
              },TIME_TO_PURGE_ZIPS);
            }).catch(function(err){
              log.warn(`Could not finalize zip at ${destination}, ${err.message}`);
              res.status(500).send('<h1>Internal server error</h1>');
            });
          }).catch(function(err) {
            archiver.failureCleanup().then(function() {
              log.warn(`Error zipping ${source}, ${err.message}`);
              res.status(500).send('<h1>Internal server error</h1>');
            });
          });
        } else {
          log.info(`Serving zip for ${reqPath} at  ${destination}`);
          res.sendFile(path.resolve(destination));
        }
      });
    });
  }
}

function serveListing(req,res,next) {
  let reqPath = decodeURIComponent(req.path);
  reqPath = reqPath.endsWith('/') ? reqPath.substring(0,reqPath.length-1) : reqPath;
  const objPath = './file-dir'+reqPath;

  fs.stat(objPath,function(err,stats) {
    if (!err && stats.isDirectory()) {
      fs.readdir(objPath,{withFileTypes: true},function(err, files) {
        if (!err) {
          let backgroundColor = "#ffffff";
            
          if (req.ip.indexOf('.') != -1) { //ipv4, that's nice.
            let ip = req.ip;
            if (ip.indexOf(':') != -1) {
              ip = ip.substr(ip.lastIndexOf(':')+1);
            }
            const sections = ip.split('.');
            backgroundColor = `rgb(${sections[0]},${sections[1]},${sections[2]})`;
          }
          let html = START_LISTING_HTML+`style="background: ${backgroundColor}"><h1 style="text-align:center">`;
          if (reqPath == "/inf") {
            html+= 'Files and Folders</h1></br><div>';
          } else {
            let backUrl = req.baseUrl+reqPath.substr(0,reqPath.lastIndexOf('/'));
            if (req.query.pass) {
              backUrl+='?pass='+req.query.pass;
            }
            html+=`<a href="${backUrl}"><i class="fa fa-backward" style="color: black; margin-right:15px;border: 5px solid black;border-radius: 10px;padding: 2px 5px 2px 0px;"></i></a>Files and Folders</h1></br>`;
            html+= `<div class="dlcenter"><a style="color: black" href="${req.originalUrl+ (Object.keys(req.query)==0 ? '?zip=1' : '&zip=1')}"><div class="dl">`
              +'<i class="fa fa-floppy-o" style="padding: 5px; font-size: 2em">  Download as Zip</i>'
              +'</div></a></div><div>';
          }
          let directories = [];
          let videos = [];
          let sounds = [];
          let pictures = [];
          let others = [];
          files.forEach(function(file){
            if (passStore.hasAccess(reqPath+'/'+file.name, req.query.pass)) {
              if (file.isDirectory()) {
                directories.push(file);
              } else {
                const period = file.name.lastIndexOf('.');
                if (period == -1) {
                  others.push(file);
                }
                else {
                  let ext = file.name.substr(period+1).toLowerCase();
                  switch (ext) {
                  case 'jpg':
                  case 'png':
                  case 'gif':
                    pictures.push(file);
                    break;
                  case 'mp3':
                  case 'opus':
                  case 'wav':
                  case 'ogg':
                  case 'flac':
                  case 'm4a':
                    sounds.push(file);
                    break;
                  case 'm4v':
                  case 'mp4':
                  case 'mkv':
                  case 'webm':
                    videos.push(file);
                    break;
                  default:
                    others.push(file);
                  }
                }
              }
            }
          });
                          
          directories.forEach(function(file) {
            const fileWithQuery = `${encodeURIComponent(file.name)+(req.query.pass ? '?pass='+req.query.pass : '')}`;
            const pathUrl = `/files${reqPath}/${fileWithQuery}`;
            const lossyUrl = `/lossy${reqPath}/${fileWithQuery}`;
            if (file.isDirectory()) {
              html+=`<span class="main"><a href="${pathUrl}"><i class="fa fa-folder fa-6" style="color:black; font-size: 17em"></i></a><span class="text">${file.name}</span></span>`;
            }
          });
                        
          pictures.forEach(function(file) {
            const fileWithQuery = `${encodeURIComponent(file.name)+(req.query.pass ? '?pass='+req.query.pass : '')}`;
            const pathUrl = `/files${reqPath}/${fileWithQuery}`;
            const lossyUrl = `/lossy${reqPath}/${fileWithQuery}`;
            const period = file.name.lastIndexOf('.');
            let ext = file.name.substr(period+1).toLowerCase();
            switch (ext) {
            case 'jpg':
            case 'png':
            case 'gif':
              const thumbnailPath = `/thumbnails${reqPath}/${fileWithQuery}`;
              html+= `<span class="main"><a href="${lossyUrl}"><img src="${thumbnailPath}" id=${file.name} onerror="this.src='/assets/warning.png'" alt="${file.name}" width="256"></a><span class="text">${file.name}</span></span>`;
              break;
            }
          });
                        
          others.forEach(function(file) {
            const fileWithQuery = `${encodeURIComponent(file.name)+(req.query.pass ? '?pass='+req.query.pass : '')}`;
            const pathUrl = `/files${reqPath}/${fileWithQuery}`;
            const lossyUrl = `/lossy${reqPath}/${fileWithQuery}`;
            const period = file.name.lastIndexOf('.');
            let ext = file.name.substr(period+1).toLowerCase();
            html+=`<span class="main"><a href="${pathUrl}"><i class="fa fa-file fa-6" style="color:black; font-size: 17em"></i></a><span class="text">${file.name}</span></span>`;
          });

          sounds.forEach(function(file) {
            const fileWithQuery = `${encodeURIComponent(file.name)+(req.query.pass ? '?pass='+req.query.pass : '')}`;
            const pathUrl = `/files${reqPath}/${fileWithQuery}`;
            const lossyUrl = `/lossy${reqPath}/${fileWithQuery}`;
            const period = file.name.lastIndexOf('.');
            let ext = file.name.substr(period+1).toLowerCase();
            switch (ext) {
            case 'mp3':
              html+=`<span class="main"><audio controls width="256"><source src="${pathUrl}" type="audio/mpeg"></audio><div><a href="${pathUrl}">${file.name}</a></div></span>`;
              break;
            case 'opus':
              ext="ogg; codecs=opus";
            case 'wav':
            case 'ogg':
            case 'flac':
              html+=`<span class="main"><audio controls width="256"><source src="${pathUrl}" type="audio/${ext}"></audio><div><a href="${pathUrl}">${file.name}</a></div></span>`;
              break;
            case 'm4a':
              html+=`<span class="main"><audio controls width="256"><source src="${pathUrl}" type="audio/mp4"></audio><div><a href="${pathUrl}">${file.name}</a></div></span>`;
              break;
            }    
          });

          videos.forEach(function(file) {
            const fileWithQuery = `${encodeURIComponent(file.name)+(req.query.pass ? '?pass='+req.query.pass : '')}`;
            const pathUrl = `/files${reqPath}/${fileWithQuery}`;
            const lossyUrl = `/lossy${reqPath}/${fileWithQuery}`;
            const period = file.name.lastIndexOf('.');
            let ext = file.name.substr(period+1).toLowerCase();
            switch (ext) {
            case 'mkv':
              html+=`<span class="main"><video controls height="480" preload="metadata"><source src="${pathUrl}"></video><div><a href="${pathUrl}">${file.name}</a></div></span>`;
              break;
            case 'm4v':
              ext="mp4";
            case 'mp4':
            case 'webm':
              html+=`<span class="main"><video controls height="480" preload="metadata"><source src="${pathUrl}" type="video/${ext}"></video><div><a href="${pathUrl}">${file.name}</a></div></span>`;
              break;
            }
          });

          res.status(200).send(html+END_LISTING_HTML);
        } else {
          log.warn(`Could not read dir=${objPath}. {err.message}`);
          res.status(500).send('<h1>Internal server error</h1>');
        }
      });
    } else {
      //not err or not dir
      next();
    }
  });
}

const serveStatic = express.static('./file-dir');

const platform = os.platform();
const arch = os.arch();
function getStats(req,res) {
  res.status(200).json({
    platform: platform,
    arch: arch,
    freemem: os.freemem(),
    uptime: os.uptime(),
    loadavg: os.loadavg(),
    cpus: os.cpus()
  });
}


function makeThumbnail(req,res,next) {
  let reqPath = decodeURIComponent(req.path);
  reqPath = reqPath.endsWith('/') ? reqPath.substring(0,reqPath.length-1) : reqPath;
  const originalPath = path.join(FILE_DIR,'.'+reqPath);
  const lastSlash = reqPath.lastIndexOf('/');
  const directory = path.join('./thumbnails','.'+reqPath.substr(0,lastSlash));
  const file = reqPath.substr(lastSlash+1);
  const output = path.resolve(directory, file);
  fs.access(output,fs.constants.R_OK,function(err){
    if (!err) {
      next();
    } else {
      mkdirp(directory).then(() => {
        fs.readFile(originalPath,function(err,imageBuffer) {
          if (!err) {
            sharp(imageBuffer)
              .resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true })
              .toFile(output, function(err, info) {
                if (!err) {
                  next();
                } else {
                  log.warn(`Could not create thumbnail for ${originalPath}, ${err.message}`);
                  res.sendFile(originalPath);
                }
              });
          } else {
            log.warn(`Could not create thumbnail for ${originalPath}, ${err.message}`);            
            res.sendFile(originalPath);
          }
        });
      }).catch((err)=> {
        log.warn(`Could not create thumbnail for ${originalPath}, ${err.message}`);
        res.sendFile(originalPath);
      });
    }
  });
}

const otfCompression = shrinkRay({
  cacheSize: COMPRESSION_CACHE_SIZE,
  threshold: COMPRESSION_MIN_SIZE,
  zlib: {
    level: COMPRESSION_ZLIB_LEVEL
  },
  brotli: {
    quality: COMPRESSION_BROTLI_LEVEL
  },
  filter: function(req,res) {
    if (req.baseUrl != '/files' || req.headers['x-no-compression']) {
      return false; //dont compress
    } else {
      return shrinkRay.filter(req,res);
    }
  }
});

function makeLossyImage(originalPath, lossyPath, returnImage) {
  return new Promise(function(resolve, reject) {
    let func = returnImage ? fs.readFile : fs.stat;
    func(lossyPath,function(err,data) {
      if (err) {
        //cant find, generate.
        fs.readFile(originalPath,function(err,data){
          if (err) {
            log.warn('err='+err.message);
            reject();
          } else {
            imagemin.buffer(data, {
              plugins: [imagejpg({quality:80}), imagepng(), imagegif()]
            }).then(function(out) {
              const lastSlash = lossyPath.lastIndexOf('/');
              const directory = lossyPath.substr(0,lastSlash);
              mkdirp(directory).then(() => {
                fs.writeFile(lossyPath, out, {mode: FILE_CREATION_MODE}, function(err){
                  if (err) {
                    log.warn(`Error writting lossy file result ${lossyPath}, ${err.message}`);
                  }
                });
              }).catch((err)=>{
                log.warn(`Error making dir for lossy file result ${lossyPath}, ${err.message}`);
              });
              resolve(out);
            }).catch(function(err) {
              log.warn('err='+err.message);
              reject();
            });
          }
        });
      } else {
        resolve(returnImage ? data : undefined);
      }
    });
  });
}

function imageCompress(req, res, next) {
  let reqPath = decodeURIComponent(req.path);
  reqPath = reqPath.endsWith('/') ? reqPath.substring(0,reqPath.length-1) : reqPath;
  const originalPath = path.join(FILE_DIR,'.'+reqPath);
  const lossyPath = path.resolve('./lossy','.'+reqPath);
  
  if (req.headers['x-no-compression'] || req.query.original == '1') {
    res.sendFile(originalPath);
  } else {
    const dot = req.path.lastIndexOf('.');
    if (dot != -1) {
      const ext = req.path.substr(dot+1).toLowerCase();
      if (ext == 'jpg' || ext == 'jpeg' || ext == 'png' || ext == 'gif') {
        makeLossyImage(originalPath, lossyPath, true).then(function(image) {
          res.status(200).set('Content-Type', 'image/'+ext).send(image);
        }).catch(function() {
          res.sendFile(originalPath);
        });
      } else {
        res.status(404).send('<h1>Not found</h1>');
      }
    } else {
      res.status(404).send('<h1>Not found</h1>');
    }
  }
}

function closeOnSignals(listener, signals) {
  let shutdown = function() {
    listener.close();
    process.exit();
  }
  for (const signal of signals) {
    process.on(signal, shutdown);
  }
}

app.enable('trust proxy');
app.use('/favicon.ico', [express.static('./favicon.png')]),
app.use('/favicon.png', [express.static('./favicon.png')]),
app.use('/stats', [logReqs, getStats]);
app.use('/thumbnails', [forbidden, checkPassword, makeThumbnail, express.static('./thumbnails')]);
app.use('/lossy',[logReqs, forbidden, checkPassword, serveListing, imageCompress]);
app.use('/assets/fa',[express.static('./node_modules/font-awesome')]);
const WARNING_PATH = path.resolve('./warning.png');
app.use('/assets/warning.png',[function(req,res){res.sendFile(WARNING_PATH);}]);
app.use(otfCompression);
app.use('/files', [logReqs, forbidden, checkExpire, checkPassword, doZip, serveListing, serveStatic]);
