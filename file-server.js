const express = require('express');
const os = require('os');
const mkdirp = require('mkdirp');
const fs = require('graceful-fs');
const path = require('path');
const Promise = require('bluebird');
const yazl = require('yazl');
const sharp = require('sharp');
const logFd = fs.openSync('./log.txt','as',0o700);
const app = express();
const PORT = 12001;
const TIME_BETWEEN_PASSWORD_CHECK = 5 * 60000;
const TIME_TO_PURGE_ZIPS = 60 * 60000;

const HTML_STYLE = '.main {text-align: center; vertical-align: middle; position: relative; display: inline-block; padding: 10px}'
  +' .text {display:block; float:none; margin:auto; position:static}'
  +' .dl {text-align: center;border: 3px solid black;border-radius: 16px;width: 30%;display: block;margin-left: auto;margin-right: auto}';

const START_LISTING_HTML='<!DOCTYPE html><html><head><style>'+HTML_STYLE+'</style><link rel="stylesheet" href="/assets/fa/css/font-awesome.min.css"></head><body><h1 style="text-align:center">';
const END_LISTING_HTML='</div></body></html>';

mkdirp.sync('./file-dir');
mkdirp.sync('./thumbnails');
mkdirp.sync('./temp');

class Logger {
  getPrefix(type){
    return `[${new Date(Date.now()).toUTCString()} - ${type}] `; 
  }
  info(msg){
    let line = this.getPrefix('info')+msg;
    console.log(line);
    fs.write(logFd,line,function(){});
  }
  warn(msg){
    let line = this.getPrefix('warn')+msg;
    console.warn(line);
    fs.write(logFd,line,function(){});
  }
}
const log = new Logger();

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
  log.info(`Req to ${req.originalUrl}`);
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
    let pass = passStore.map[req.path.substring(1).split('/')[1]];
    if (!pass) {
      next();
    }
    else if (pass == req.query.pass) {
      next();
    } else {
      log.warn(`Bad credentials given for ${req.baseUrl}`);
      res.status(403).send('<h1>Invalid credentials</h1>');
    }
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
    this.zipfile.addFile(filePath, this.getZipPath(filePath), {mode:0o600});
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
  if (req.query.zip == '1') {
    //req.path includes slash
    let reqPath = req.path.endsWith('/') ? req.path.substring(0,req.path.length-1) : req.path;
    //TODO security still incomplete, prevent this
    if (reqPath == "/inf") {
      res.status(400).send("<h1>Cannot download root</h1>");
    }
    const source = `./file-dir${reqPath}`;
    const destination = `./file-dir/temp${reqPath}.zip`;
    
    
    mkdirp(destination.substring(0,destination.lastIndexOf('/')),{mode:0o700},function(err) {
      fs.access(destination, fs.constants.R_OK, function(err) {
        if (err) {
          //probably time to create
          //TODO get rid of the space, I messed up somewhere else.
          const archiver = new YazlArchiver(`./file-dir/ `, destination);
          //package everything
          packageRecursively(source, archiver).then(()=> {
            archiver.finalizeArchive().then(function() {
              log.info(`Serving zip for ${reqPath} at  ${destination}`);
              res.sendFile(path.resolve(destination));
              setTimeout(function(){
                log.info(`Cleanup. Deleting zip ${destination}`);
                fs.unlink(destination,function(err){
                  log.warn(`Unable to cleanup ${destination}. Is it already gone? {err.message}`);
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
  } else {
    next();
  }
}

function serveListing(req,res,next) {
  let reqPath = req.path.endsWith('/') ? req.path.substring(0,req.path.length-1) : req.path;
  const objPath = './file-dir'+reqPath;

  fs.stat(objPath,function(err,stats) {
    if (!err && stats.isDirectory()) {
      fs.readdir(objPath,{withFileTypes: true},function(err, files) {
        if (!err) {
          let html = START_LISTING_HTML;
          if (reqPath == "/inf") {
            html+= 'Files and Folders</h1></br><div>';
          } else {
            let backUrl = req.baseUrl+reqPath.substr(0,reqPath.lastIndexOf('/'));
            if (req.query.pass) {
              backUrl+='?pass='+req.query.pass;
            }
            html+=`<a href="${backUrl}"><i class="fa fa-backward" style="color: black; margin-right:15px;border: 5px solid black;border-radius: 10px;padding: 2px 5px 2px 0px;"></i></a>Files and Folders</h1></br>`;
            html+= `<a style="color: black" href="${req.originalUrl+ (Object.keys(req.query)==0 ? '?zip=1' : '&zip=1')}"><div class="dl">`
              +'<i class="fa fa-floppy-o" style="padding: 5px; font-size: 2em">  Download as Zip</i>'
              +'</div></a><div>';
          }
          files.forEach(function(file){
            if (passStore.hasAccess(reqPath+'/'+file.name, req.query.pass)) {
              const fileWithQuery = `${file.name+(req.query.pass ? '?pass='+req.query.pass : '')}`;
              const pathUrl = `/files${reqPath}/${fileWithQuery}`;
              if (file.isDirectory()) {
                html+=`<span class="main"><a href="${pathUrl}"><i class="fa fa-folder fa-6" style="color:black; font-size: 17em"></i></a><span class="text">${file.name}</span></span>`;
              } else {
                const period = file.name.lastIndexOf('.');
                if (period == -1) {
                  html+=`<span class="main"><a href="${pathUrl}"><i class="fa fa-file fa-6" style="color: black; font-size: 17em"></i></a><span class="text">${file.name}</span></span>`;
                } else {
                  let ext = file.name.substr(period+1).toLowerCase();
                  switch (ext) {
                  case 'jpg':
                  case 'png':
                  case 'gif':
                    const thumbnailPath = `/thumbnails${reqPath}/${fileWithQuery}`;
                    html+= `<span class="main"><a href="${pathUrl}"><img src="${thumbnailPath}" id=${file.name} onerror="this.src='/assets/warning.png'" alt="${file.name}" width="256"></a><span class="text">${file.name}</span></span>`;
                    break;
                  case 'mp3':
                    html+=`<span class="main"><a href="${pathUrl}"><img src="${pathUrl}" alt="${file.name}" width="256"></a><span>${file.name}</span></span>`;
                    break;
                  case 'mp4':
                  case 'webm':
                    html+=`<span class="main"><a href="${pathUrl}"><img src="${pathUrl}" alt="${file.name}" width="256"></a><span>${file.name}</span></span>`;
                    break;
                  default:
                    html+=`<span class="main"><a href="${pathUrl}"><i class="fa fa-file fa-6" style="color:black; font-size: 17em"></i></a><span class="text">${file.name}</span></span>`;
                  }
                }
              }
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
  const reqPath = req.path.endsWith('/') ? req.path.substring(0,req.path.length-1) : req.path;
  const originalPath = path.resolve('./file-dir','.'+reqPath);
  const lastSlash = reqPath.lastIndexOf('/');
  const directory = path.join('./thumbnails','.'+reqPath.substr(0,lastSlash));
  const file = reqPath.substr(lastSlash+1);
  const output = path.resolve(directory, file);
  fs.access(output,fs.constants.R_OK,function(err){
    if (!err) {
      next();
    } else {
      mkdirp(directory, function(err){
        if (!err) {          
          const imageBuffer = fs.readFileSync(originalPath);
          
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
    }
  });
}

app.use('/stats', [logReqs, getStats]);
app.use('/thumbnails', [forbidden, checkPassword, makeThumbnail, express.static('./thumbnails')]);
app.use('/files', [logReqs, forbidden, checkExpire, checkPassword, doZip, serveListing, serveStatic]);
app.use('/assets/fa',[express.static('./node_modules/font-awesome')]);
const WARNING_PATH = path.resolve('./warning.png');
app.use('/assets/warning.png',[function(req,res){res.sendFile(WARNING_PATH);}]);
app.listen(PORT, function(){log.info('Listening on '+PORT)});
