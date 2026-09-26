export class MwgPlayer {
  constructor(canvas, project) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.project = project; this.map = null;
    this.player = { ...(project.player || { x: 0, y: 0 }), moving: false, fromX: 0, fromY: 0, toX: 0, toY: 0, moveProgress: 0 }; this.switches = {}; this.variables = {}; this.dialogue = null; this.dialogueDone = null; this.keys = new Set(); this.tileSize = 32; this.lastTime = 0;
    this.mwg = globalThis.mw_games; this.gameState = this.mwg?.Rpg ? new this.mwg.Rpg.GameState() : null;
    window.addEventListener('keydown', event => { this.keys.add(event.key.toLowerCase()); if (['arrowup','arrowdown','arrowleft','arrowright',' ','enter'].includes(event.key.toLowerCase())) event.preventDefault(); if (this.dialogue && ['enter',' '].includes(event.key.toLowerCase())) { this.dialogue = null; this.dialogueDone?.(); this.dialogueDone = null; } });
    window.addEventListener('keyup', event => this.keys.delete(event.key.toLowerCase())); this.loadMap(this.player.mapId || project.initialMapId || project.maps[0]?.id); requestAnimationFrame(time => this.frame(time));
  }
  loadMap(id) { const entry = this.project.maps.find(map => map.id === Number(id)); if (!entry) return; this.mapEntry = entry; this.map = entry.data; this.player.mapId = entry.id; this.player.x = Math.max(0, Math.min(this.map.width - 1, this.player.x || 0)); this.player.y = Math.max(0, Math.min(this.map.height - 1, this.player.y || 0)); }
  frame(time) { const dt = this.lastTime ? Math.min(0.05, (time - this.lastTime) / 1000) : 0; this.lastTime = time; if (!this.dialogue) this.update(dt); this.render(); requestAnimationFrame(next => this.frame(next)); }
  update(dt) {
    if (this.player.moving) {
      this.player.moveProgress = Math.min(1, this.player.moveProgress + dt / 0.11);
      if (this.player.moveProgress >= 1) { this.player.x = this.player.toX; this.player.y = this.player.toY; this.player.moving = false; if (this.player.x !== this.player.fromX || this.player.y !== this.player.fromY) this.runEvents(this.player.x, this.player.y); }
      return;
    }
    const d = this.keys.has('arrowup') || this.keys.has('w') ? [0,-1] : this.keys.has('arrowdown') || this.keys.has('s') ? [0,1] : this.keys.has('arrowleft') || this.keys.has('a') ? [-1,0] : this.keys.has('arrowright') || this.keys.has('d') ? [1,0] : null;
    if (!d) return;
    const x = this.player.x + d[0], y = this.player.y + d[1];
    const walkable = this.canWalk(x, y); this.player.moving = true; this.player.fromX = this.player.x; this.player.fromY = this.player.y; this.player.toX = walkable ? x : this.player.x; this.player.toY = walkable ? y : this.player.y; this.player.moveProgress = 0;
  }
  canWalk(x,y) {
    if (!this.map || x<0 || y<0 || x>=this.map.width || y>=this.map.height) return false;
    const tilesetId = this.map.tilesetId ?? this.mapEntry?.tilesetId;
    const flags = this.project.tilesets?.[tilesetId]?.flags;
    if (Array.isArray(flags)) {
      const size = this.map.width * this.map.height, bit = directionBit(x - this.player.x, y - this.player.y);
      for (let layer = 3; layer >= 0; layer--) {
        const tile = this.map.data?.[layer * size + y * this.map.width + x] || 0;
        const flag = Number(flags[tile] || 0);
        if ((flag & 0x10) !== 0) continue;
        if ((flag & bit) === 0) return this.eventAllowsStep(x, y);
      }
      return false;
    }
    return this.eventAllowsStep(x, y);
  }
  eventAllowsStep(x,y) {
    const event = this.mapEntry?.mwgEvents?.find(item => item && item.x === x && item.y === y);
    if (event && this.mwg?.Rpg?.activePage) {
      const page = this.mwg.Rpg.activePage(event, this.gameState);
      if (page?.through === true || (page && (page.priorityType ?? 1) !== 1)) return true;
      if (page) return false;
    }
    const raw = (this.map.events || []).find(item => item && item.x === x && item.y === y);
    return !raw || raw.pages?.every(page => page.through) !== false;
  }
  runEvents(x,y) { for (const event of this.map.events||[]) { if (!event || event.x!==x || event.y!==y) continue; const source=this.mapEntry?.mwgEvents?.find(candidate=>candidate.id===String(event.id)); const page=source&&this.mwg?.Rpg?.activePage ? this.mwg.Rpg.activePage(source,this.gameState) : (event.pages||[]).find(candidate=>this.pageMatches(candidate)&&[1,2].includes(candidate.trigger)); if(!page || (source && page.trigger!=='touch')) continue; const commands=page.commands||this.toMwgCommands(page.list||[]); if(this.mwg?.Rpg?.EventRunner&&commands.length) new this.mwg.Rpg.EventRunner({game:this.gameState,present:request=>new Promise(resolve=>{this.dialogue=request.text;this.dialogueDone=resolve;})}).run(commands); else this.interpret(page.list||[]); } }
  toMwgCommands(list) { const commands=[]; for(const command of list) { if(command.code===401) commands.push({say:command.parameters?.[0]||''}); if(command.code===121) for(let id=command.parameters[0];id<=command.parameters[1];id++) commands.push({setSwitch:String(id),value:command.parameters[2]===0}); if(command.code===122) commands.push({setVariable:String(command.parameters[0]),value:Number(command.parameters[4]||0)}); } return commands; }
  pageMatches(page) { const c=page.conditions||{}; return (!c.switch1Valid||Boolean(this.switches[c.switch1Id]))&&(!c.switch2Valid||Boolean(this.switches[c.switch2Id]))&&(!c.variableValid||Number(this.variables[c.variableId]||0)>=c.variableValue); }
  interpret(list) { const lines=[]; for(const command of list) { if(command.code===401) lines.push(command.parameters?.[0]||''); if(command.code===121) for(let id=command.parameters[0];id<=command.parameters[1];id++) this.switches[id]=command.parameters[2]===0; if(command.code===122) this.variables[command.parameters[0]]=command.parameters[4]||0; if(command.code===201&&command.parameters?.[0]===0){this.player.mapId=command.parameters[1];this.player.x=command.parameters[2];this.player.y=command.parameters[3];this.loadMap(this.player.mapId);} } if(lines.length)this.dialogue=lines.join('\n'); }
  render() { const width=this.canvas.width=this.project.display?.width||816,height=this.canvas.height=this.project.display?.height||624,ctx=this.ctx; ctx.fillStyle='#10131b';ctx.fillRect(0,0,width,height);if(!this.map)return;const renderX=this.player.moving?this.player.fromX+(this.player.toX-this.player.fromX)*this.player.moveProgress:this.player.x,renderY=this.player.moving?this.player.fromY+(this.player.toY-this.player.fromY)*this.player.moveProgress:this.player.y,cols=Math.ceil(width/this.tileSize)+1,rows=Math.ceil(height/this.tileSize)+1,ox=Math.max(0,Math.min(this.map.width-cols,renderX-Math.floor(cols/2)))*this.tileSize,oy=Math.max(0,Math.min(this.map.height-rows,renderY-Math.floor(rows/2)))*this.tileSize;for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){const mx=x+ox/this.tileSize,my=y+oy/this.tileSize;if(mx>=this.map.width||my>=this.map.height)continue;const tile=this.map.data?.[my*this.map.width+mx]||0;ctx.fillStyle=tileColor(tile);ctx.fillRect(x*this.tileSize-ox%this.tileSize,y*this.tileSize-oy%this.tileSize,this.tileSize+1,this.tileSize+1);}const px=renderX*this.tileSize-ox+this.tileSize/2,py=renderY*this.tileSize-oy+this.tileSize/2;ctx.fillStyle='#f3c969';ctx.beginPath();ctx.arc(px,py,10,0,Math.PI*2);ctx.fill();if(this.dialogue){ctx.fillStyle='rgba(12,15,24,.94)';ctx.fillRect(24,height-150,width-48,126);ctx.strokeStyle='#829bff';ctx.strokeRect(24,height-150,width-48,126);ctx.fillStyle='#fff';ctx.font='18px sans-serif';this.dialogue.split('\n').forEach((line,i)=>ctx.fillText(line,44,height-112+i*26));} }
}
function directionBit(dx, dy){ if(dy>0)return 0x01; if(dx<0)return 0x02; if(dx>0)return 0x04; return 0x08; }
function tileColor(id){return id?`hsl(${id*47%360} 25% ${28+id%12}%)`:'#18202b';}
