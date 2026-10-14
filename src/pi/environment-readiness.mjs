/** Pi redirects extension startup stdout to stderr while protecting RPC output.
 * Forward only the bounded readiness shape, once; never forward diagnostics. */
export function environmentReadinessForwarder(deliver) {
  let buffer='',sent=false;
  return chunk=>{
    if(sent)return;
    buffer+=String(chunk);
    if(buffer.length>8192)buffer=buffer.slice(-8192);
    let newline;
    while((newline=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
      if(line.length>2048)continue;
      try{
        const value=JSON.parse(line);
        if(!value||Array.isArray(value)||value.type!=='environment_ready'||Object.keys(value).sort().join(',')!=='tools,type'||!Array.isArray(value.tools)||!value.tools.length||value.tools.length>32||new Set(value.tools).size!==value.tools.length||value.tools.some(tool=>typeof tool!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(tool)))continue;
        sent=true;deliver(JSON.stringify(value));return;
      }catch{}
    }
  };
}
