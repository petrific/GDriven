const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');
const readline = require('readline');
const {google} = require('googleapis');
const OAuth2Client = google.auth.OAuth2;
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const TOKEN_PATH = 'credentials.json';
var filesToLoad = [];
var foldersToSearch = [];
var md5s = {};
var config;
/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
function authorize(credentials, callback) {
  const {client_secret, client_id, redirect_uris} = credentials.installed;
  const oAuth2Client = new OAuth2Client(client_id, client_secret, redirect_uris[0]);

  // Check if we have previously stored a token.
  fs.readFile(config.Token, (err, token) => {
    if (err) return getAccessToken(oAuth2Client, callback);
    oAuth2Client.setCredentials(JSON.parse(token));
    callback(oAuth2Client);
  });
}

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback for the authorized client.
 */
function getAccessToken(oAuth2Client, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('Enter the code from that page here: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) return callback(err);
      oAuth2Client.setCredentials(token);
      // Store the token to disk for later program executions
      fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
        if (err) console.error(err);
        console.log('Token stored to', TOKEN_PATH);
      });
      callback(oAuth2Client);
    });
  });
}

/**
 * Lists the names and IDs of up to 10 files.
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 */
function listFiles(auth, currRoot, parentDir, callback) {
  const drive = google.drive({version: 'v3', auth});
  var root = currRoot;
  drive.files.list({
    pageSize: 1000,
    fields: 'nextPageToken, files(id, name, mimeType, md5Checksum)',
    q: `'${parentDir}' in parents`
  }, (err, {data}) => {
    if (err) return console.log('The API returned an error: ' + err);
    const files = data.files;
    if (files.length) {
       files.map((file, index) => {
       console.log(`Processing ${file.name}...`);
       file.name = file.name.replace('/', '_').replace('\\','_');
        if(file.mimeType == 'application/vnd.google-apps.folder'){
          var newRoot =`${root}\\${file.name}`;
          if(config.Mappings[file.name]){
            newRoot = config.Mappings[file.name];
          }
          if(newRoot && !fs.existsSync(newRoot))
          { 
            mkdirp.sync(newRoot); 
          }
          foldersToSearch.push({Root: newRoot, Id: file.id});  
        }else{
          var newRoot =`${root}`;
          if(md5s[file.id] != file.md5Checksum){
            filesToLoad.push({Root: newRoot, File: file});
          }
        }
        if(index == files.length -1){
          callback();
        }
      });
    } else {
      console.log('No files found.');
    }
  });
}

function downloadFile(auth, rootFolder, file, callback){
  const drive = google.drive({version: 'v3', auth});
  var filePath = `${rootFolder}\\${file.name}`;
  drive.files.get({
    fileId: file.id,
    alt:'media'
  }, function(err, data) {
    if(err){
      console.error('ERROR:', err);
    }else{
      console.log(`Saving file ${filePath}...`);
      if(config.Mappings[file.name]){
        filePath = config.Mappings[file.name];
      }
      fs.appendFileSync(filePath, data.data);
      md5s[file.id] = file.md5Checksum;
    }
    callback();
  });
}

var getFolder = function (auth, root, id){
  foldersToSearch.push({Root: root, Id : id});
  var searchFunc = function() {
    var authIn = auth;
    if(foldersToSearch.length > 0){
       listFiles(authIn, foldersToSearch[0].Root, foldersToSearch[0].Id, function() {
        foldersToSearch.splice(0,1);
        searchFunc();  
       });
    }else{
      console.log("Downloading files...");
      downloadFunc();
    }
  };

  var downloadFunc = function() {
    var authIn = auth;
    if(filesToLoad.length > 0){
       downloadFile(authIn, filesToLoad[0].Root, filesToLoad[0].File, function() {
        filesToLoad.splice(0,1);
        downloadFunc();
       });
    }else{
      if(fs.existsSync(config.MD5File)){
        console.log("Deleting old checksum file...");
        fs.unlinkSync(config.MD5File);
      }
      console.log("Saving new checksum file...");
      fs.writeFile(config.MD5File, JSON.stringify(md5s));
    }
  };
  console.log("Searching folder...");
  searchFunc();
}


var uploadFile = function(auth, root, file){
  var drive = google.drive({version: 'v3', auth});
  var fileStream = fs.createReadStream(file);
  var fileMetadata = {
    'name' : path.basename(file),
    'parents': [root]
  };
  var media = {
    body : fileStream
  };

  drive.files.create({
    resource : fileMetadata,
    media : media,
    fields: 'id'}, 
    function(err, file) {
      if(err){
        console.error(err);
      } else {
        console.log(`File ${file.data.id} uploaded sucessfully`);
      }
    });
}

var loadChecksums = function(err, data) 
{
  if(err)
  {
    console.err(err);
  }
  md5s = JSON.parse(data);
  fs.readFile(config.Secret, loadSecret);  
}

var loadConfiguration = function(err, data)
{
  if(err)
  {
    console.err(err);
  }
  config = JSON.parse(data);
  if(config.MD5File && fs.existsSync(config.MD5File)){
    fs.readFile(config.MD5File, loadChecksums);
  }else
  {
    fs.readFile(config.Secret, loadSecret);
  }
}

var processData = function(auth)
{
  if(process.argv[2] == 'd'){
    getFolder(auth, config.RootFolder, config.RootId);
  }else{
    uploadFile(auth, config.TargetFile, process.RootId);
  }
}

var loadSecret = function(err, data)
{
  if(err)
  {
    console.err(err);
  }
  var token = JSON.parse(data);
  authorize(token, processData);
}


fs.readFile(`${process.argv[3]}`, loadConfiguration);

