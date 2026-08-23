const http=require('http'), fs=require('fs'), path=require('path');
const ROOT='/home/claude/work/test';
const MIME={'.html':'text/html; charset=utf-8','.webm':'video/webm','.mp4':'video/mp4','.srt':'text/plain','.ass':'text/plain','.js':'text/javascript'};
http.createServer((req,res)=>{
  const p=path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if(!p.startsWith(ROOT)||!fs.existsSync(p)||fs.statSync(p).isDirectory()){res.writeHead(404);return res.end('nf');}
  const size=fs.statSync(p).size, type=MIME[path.extname(p)]||'application/octet-stream';
  const range=req.headers.range;
  if(range){
    const m=/bytes=(\d*)-(\d*)/.exec(range);
    const start=m[1]?parseInt(m[1]):0, end=m[2]?parseInt(m[2]):size-1;
    res.writeHead(206,{'Content-Type':type,'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':end-start+1});
    fs.createReadStream(p,{start,end}).pipe(res);
  } else {
    res.writeHead(200,{'Content-Type':type,'Accept-Ranges':'bytes','Content-Length':size});
    fs.createReadStream(p).pipe(res);
  }
}).listen(8123,'0.0.0.0',()=>console.log('server on 8123'));
