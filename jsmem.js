// --------------------------------------------------------------------------------------
// Modules

var lazy = require("lazy");
var fs = require("fs");

// --------------------------------------------------------------------------------------
// Globals

var processedLineCount = 0;
var freedAllocations = 0;
var strings = [];
var allocations = {};
var nodes = {};
var children = {};

// --------------------------------------------------------------------------------------
// Log Parsing

function processLine(line)
{
  processedLineCount++;
  line = String(line).replace(/(\r\n|\n|\r)/gm, "");

  var pieces = line.split(" ");
  var cmd = pieces.shift();

  if(cmd == 'S')
  {
    var index = parseInt(pieces.shift());
    strings[index] = pieces.join(" ");
  }
  else if(cmd == 'A')
  {
    var parent = '#';
    var id = pieces[0];
    var size = pieces[1];
    var stack = pieces[2];
    allocations[id] = {
      size: size,
      stack: stack
    };
  }
  else if(cmd == 'F')
  {
    var id = pieces[0];
    delete allocations[id];
    freedAllocations++;
  }
}

function inflateNode(frameid, frame, parent, size)
{
  var node;
  if(nodes.hasOwnProperty(frameid))
  {
    node = nodes[frameid];
  }
  else
  {
    var fileAndLine, filename, lineNo, name;
    if(frame == 'C')
    {
      name = 'By Stacktrace (top down)';
    }
    else if(frame == 'D')
    {
      name = 'By Stacktrace (bottom up)';
    }
    else if(frame == 'F')
    {
      name = 'Anywhere in Stacktrace';
    }
    else if(frame == 'L')
    {
      name = 'Leaf Nodes Only';
    }
    else
    {
      fileAndLine = frame.split(":");
      filename = strings[parseInt(fileAndLine[0])];
      lineNo = parseInt(fileAndLine[1]);
      if(isNaN(lineNo))
      {
        return false;
      }
      name = filename+":"+lineNo;
    }

    node = {
      id: frameid,
      parent: parent,
      text: name,
      state: {
        opened: false
      },
      children: false,
      data: {
        count: 0,
        size: 0
      }
    };
    nodes[frameid] = node;
    children[frameid] = {};
  }

  if(nodes.hasOwnProperty(parent))
  {
    nodes[parent].children = true;
  }
  if(parent == '#' || nodes.hasOwnProperty(parent))
  {
    children[parent][node.id]++;
  }

  node.data.count++;
  node.data.size += size;
  return true;
}

function buildTree()
{
  var liveIds = Object.keys(allocations);
  console.log("Loaded file ["+processedLineCount+" lines]; "+liveIds.length+" live allocations ("+freedAllocations+" freed), "+strings.length+" entries in stringtable.");
  console.log("Building tree...");

  for (var i = 0; i < liveIds.length; i++)
  {
    var id = liveIds[i];
    var alloc = allocations[id];
    var parent, stack, frameid;

    if((i % 1000) == 0)
    {
      console.log("Processing "+i+"/"+liveIds.length+" allocations...");
    }

    parent = '#';
    stack = alloc.stack.split("/");
    stack.push("C");
    frameid = "";
    for(var j = stack.length - 1; j >= 0; j--)
    {
      var frame = stack[j];
      if((frame != "C") && (frame.indexOf(":") == -1))
        continue;

      if(frameid.length > 0)
        frameid += "/";
      frameid += frame;

      if(inflateNode(frameid, frame, parent, parseInt(alloc.size)))
      {
        parent = frameid;
      }
    }

/*
    parent = '#';
    stack = alloc.stack.split("/");
    stack.unshift("D");
    frameid = "";
    for(var j = 0; j < stack.length; j++)
    {
      var frame = stack[j];
      if((frame != "D") && (frame.indexOf(":") == -1))
        continue;

      if(frameid.length > 0)
        frameid += "/";
      frameid += frame;

      if(inflateNode(frameid, frame, parent, parseInt(alloc.size)))
      {
        parent = frameid;
      }
    }

    parent = '#';
    stack = alloc.stack.split("/");
    stack.push("F");
    frameid = "";
    for(var j = stack.length - 1; j >= 0; j--)
    {
      var frame = stack[j];
      if((frame != "F") && (frame.indexOf(":") == -1))
        continue;

      frameid = frame;

      if(inflateNode(frameid, frame, parent, parseInt(alloc.size)))
      {
        parent = "F";
      }
    }
*/
    parent = '#';
    stack = alloc.stack.split("/");
    stack.unshift("L");
    frameid = "";
    var len = stack.length;
    if(len > 2)
      len = 2; // only visit leaves
    for(var j = 0; j < len; j++)
    {
      var frame = stack[j];
      if((frame != "L") && (frame.indexOf(":") == -1))
        continue;

      frameid = frame;

      if(inflateNode(frameid, frame, parent, parseInt(alloc.size)))
      {
        parent = "L";
      }
    }
  }

  var childIds = Object.keys(children);
  for(var i = 0; i < childIds.length; i++)
  {
    // Convert all children entries from a set into a sorted array
    var id = childIds[i];
    var childIdList = Object.keys(children[id]);
    var childList = [];
    for(var j = 0; j < childIdList.length; j++)
    {
      childList.push(nodes[childIdList[j]]);
    }
    childList.sort(function(a, b) {
      return b.data.size - a.data.size;
    });
    children[id] = childList;
  }
}

function onDataLoaded()
{
  buildTree();
  // console.log(JSON.stringify(children, null, 2));
  runServer();
}

// --------------------------------------------------------------------------------------
// Main

var args = require('minimist')(process.argv.slice(2), {
  boolean: ['h', 'v'],
  alias: {
    help: 'h',
    verbose: 'v'
  }
});

if(args.help || (args._.length < 1))
{
  console.error("Syntax: node jsmem.js [-v] jsmemlog.txt\n");
  console.error("        -h,--help         This help output");
  console.error("        -v,--verbose      Verbose output");
  process.exit(1);
}

var inputFilename = args._[0];

children["#"] = [];

// This line is annoying.
console.log("Reading "+inputFilename+"...");
new lazy(fs.createReadStream(inputFilename)).on('end', onDataLoaded).lines.forEach(processLine);

// --------------------------------------------------------------------------------------
// Server

function getNodeChildren(id) {
  console.log("Requesting children for: " + id);

  if(children.hasOwnProperty(id))
  {
    return children[id];
  }
  return [];
}

function runServer() {
  // Offer a web server to display the content in small, digestible pieces.
  var url = require('url');
  var nodeStatic = require('node-static');
  var fileServer = new nodeStatic.Server('./static');
  var http = require('http');
  http.createServer(function (request, response) {
    if(request.url.lastIndexOf('/data', 0) == 0) {
      var queryData = url.parse(request.url, true).query;
      var nodeChildren = getNodeChildren(queryData.id);
      var jsonText = JSON.stringify(nodeChildren);
      // console.log(jsonText);
      response.writeHead(200, {'Content-Type': 'application/json'});
      response.end(jsonText);
    } else {
      fileServer.serve(request, response);
    }
  }).listen(9001, '127.0.0.1');
  console.log('Server running at http://127.0.0.1:9001/');
}