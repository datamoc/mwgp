// Canvas fallback for environments without the mw_games 2D runtime: movement,
// flat tile rendering and a text box, with events driven ONLY by the converted
// MWGP vocabulary (mapEntry.mwgEvents). Raw MV command codes never appear
// here; anything the fallback cannot execute warns loudly (T127).
export class MwgPlayer {
  constructor(canvas, project) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.project = project; this.map = null;
    this.player = { ...(project.player || { x: 0, y: 0 }), moving: false, fromX: 0, fromY: 0, toX: 0, toY: 0, moveProgress: 0 };
    this.dialogue = null; this.dialogueDone = null; this.keys = new Set(); this.tileSize = 32; this.lastTime = 0;
    this.warnedPages = new Set();
    this.rpg = globalThis.mw_games?.Rpg || null;
    if (!this.rpg) console.error('MWGP fallback renderer: mw_games Rpg layer missing; events disabled');
    this.gameState = this.rpg ? new this.rpg.GameState() : null;
    window.addEventListener('keydown', event => {
      const key = event.key.toLowerCase(); this.keys.add(key);
      if (['arrowup','arrowdown','arrowleft','arrowright',' ','enter'].includes(key)) event.preventDefault();
      if (!this.dialogue) return;
      if (this.dialogue.choices.length && (key === 'arrowup' || key === 'arrowleft')) this.dialogue.index = (this.dialogue.index + this.dialogue.choices.length - 1) % this.dialogue.choices.length;
      else if (this.dialogue.choices.length && (key === 'arrowdown' || key === 'arrowright')) this.dialogue.index = (this.dialogue.index + 1) % this.dialogue.choices.length;
      else if (key === 'enter' || key === ' ') this.closeDialogue(this.dialogue.choices.length ? valueOfChoice(this.dialogue.choices[this.dialogue.index]) : undefined);
      else if (key === 'escape') this.closeDialogue(CANCEL);
    });
    window.addEventListener('keyup', event => this.keys.delete(event.key.toLowerCase()));
    this.loadMap(this.player.mapId || project.initialMapId || project.maps[0]?.id);
    requestAnimationFrame(time => this.frame(time));
  }
  closeDialogue(value) { const done = this.dialogueDone; this.dialogue = null; this.dialogueDone = null; done?.(value); }
  // Dialogue presenter for EventRunner: text-only box plus a real choice list
  // when the command carries choices, so an ask resolves to a chosen value.
  present(request) {
    return new Promise(resolve => {
      this.dialogue = { text: request.text || '', choices: request.choices || [], index: 0 };
      this.dialogueDone = resolve;
    });
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
    // Same rule as the real player: only a "Same as characters" page blocks.
    const event = this.mapEntry?.mwgEvents?.find(item => item && item.x === x && item.y === y);
    if (!event || !this.rpg) return true;
    const page = this.rpg.activePage(event, this.gameState);
    if (!page || page.through === true) return true;
    return (page.priorityType ?? 1) !== 1;
  }
  runEvents(x,y) {
    if (!this.rpg || !this.gameState) return;
    for (const event of this.mapEntry?.mwgEvents || []) {
      if (!event || event.x !== x || event.y !== y) continue;
      const page = this.rpg.activePage(event, this.gameState);
      if (!page || page.trigger !== 'touch') continue;
      this.runConvertedPage(page, event);
    }
  }
  async runConvertedPage(page, event) {
    const commands = this.prepareFallbackCommands(page.commands || []);
    this.warnFallbackGaps(page, event);
    const runner = () => new this.rpg.EventRunner({ game: this.gameState, present: request => this.present(request) });
    try {
      if (page.story) {
        const passages = Object.fromEntries(Object.entries(page.story.passages || {}).map(([name, body]) => [name, this.prepareFallbackCommands(body)]));
        await runner().runStory(passages, page.story.start || 'main');
      } else if (commands.length) {
        await runner().run(commands);
      }
    } catch (error) { console.error('MWGP fallback event failed', event?.id, error); }
  }
  // Rewrite the converted commands the fallback can execute into runner-native
  // shapes ({call} closures); everything else passes through to EventRunner,
  // which runs its native subset and ignores the rest (warned by warnFallbackGaps).
  prepareFallbackCommands(commands) {
    return (commands || []).map(command => {
      if (command.transfer) {
        const spec = command.transfer;
        return { call: () => {
          const mapId = spec.mapId ?? Number(this.gameState.variable(String(spec.mapVar)));
          const x = spec.x ?? Number(this.gameState.variable(String(spec.xVar)));
          const y = spec.y ?? Number(this.gameState.variable(String(spec.yVar)));
          this.player.mapId = mapId; this.player.x = x; this.player.y = y; this.loadMap(mapId);
        } };
      }
      if (command.ask !== undefined && command.branches) {
        const { branches, cancelBranch } = command;
        const preparedBranches = Object.fromEntries(Object.entries(branches).map(([index, body]) => [index, this.prepareFallbackCommands(body)]));
        const preparedCancel = this.prepareFallbackCommands(cancelBranch || []);
        return { call: async () => {
          const chosen = await this.present({ text: command.ask, speaker: command.speaker, portrait: command.portrait, choices: command.choices });
          const runBranch = async body => { const nested = new this.rpg.EventRunner({ game: this.gameState, present: request => this.present(request) }); await nested.runList(body); };
          if (chosen === CANCEL) { if (preparedCancel.length) await runBranch(preparedCancel); return; }
          const index = (command.choices || []).findIndex(choice => valueOfChoice(choice) === chosen);
          if (index >= 0 && preparedBranches[index]) await runBranch(preparedBranches[index]);
          else console.warn('MWGP fallback renderer: choice has no branch; skipping it', { chosen });
        } };
      }
      if (command.if) return { ...command, then: this.prepareFallbackCommands(command.then), else: this.prepareFallbackCommands(command.else) };
      return command;
    });
  }
  // EventRunner silently ignores commands outside its native subset, so name
  // them once per page instead: the fallback has no scene, sound, or battle
  // layer for pictures, audio, menus, or engine scripts.
  warnFallbackGaps(page, event) {
    const key = `${this.mapEntry?.id}:${event?.id}`;
    if (this.warnedPages.has(key)) return;
    this.warnedPages.add(key);
    const kinds = new Set();
    const scan = commands => (commands || []).forEach(command => {
      const kind = Object.keys(command)[0];
      if (!NATIVE_COMMANDS.has(kind)) kinds.add(kind);
      if (command.if) { scan(command.then); scan(command.else); }
    });
    scan(page.commands);
    for (const body of Object.values(page.story?.passages || {})) scan(body);
    for (const body of Object.values(page.branches || {})) scan(body);
    if (page.cancelBranch) scan(page.cancelBranch);
    if (kinds.size) console.warn(`MWGP fallback renderer skips unsupported commands on event ${event?.id} (map ${this.mapEntry?.id}): ${[...kinds].join(', ')}`);
  }
  render() { const width=this.canvas.width=this.project.display?.width||816,height=this.canvas.height=this.project.display?.height||624,ctx=this.ctx; ctx.fillStyle='#10131b';ctx.fillRect(0,0,width,height);if(!this.map)return;const renderX=this.player.moving?this.player.fromX+(this.player.toX-this.player.fromX)*this.player.moveProgress:this.player.x,renderY=this.player.moving?this.player.fromY+(this.player.toY-this.player.fromY)*this.player.moveProgress:this.player.y,cols=Math.ceil(width/this.tileSize)+1,rows=Math.ceil(height/this.tileSize)+1,ox=Math.max(0,Math.min(this.map.width-cols,renderX-Math.floor(cols/2)))*this.tileSize,oy=Math.max(0,Math.min(this.map.height-rows,renderY-Math.floor(rows/2)))*this.tileSize;for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){const mx=x+ox/this.tileSize,my=y+oy/this.tileSize;if(mx>=this.map.width||my>=this.map.height)continue;const tile=this.map.data?.[my*this.map.width+mx]||0;ctx.fillStyle=tileColor(tile);ctx.fillRect(x*this.tileSize-ox%this.tileSize,y*this.tileSize-oy%this.tileSize,this.tileSize+1,this.tileSize+1);}const px=renderX*this.tileSize-ox+this.tileSize/2,py=renderY*this.tileSize-oy+this.tileSize/2;ctx.fillStyle='#f3c969';ctx.beginPath();ctx.arc(px,py,10,0,Math.PI*2);ctx.fill();if(this.dialogue){ctx.fillStyle='rgba(12,15,24,.94)';ctx.fillRect(24,height-150,width-48,126);ctx.strokeStyle='#829bff';ctx.strokeRect(24,height-150,width-48,126);ctx.fillStyle='#fff';ctx.font='18px sans-serif';this.dialogue.text.split('\n').forEach((line,i)=>ctx.fillText(line,44,height-112+i*26));this.dialogue.choices.forEach((choice,i)=>ctx.fillText(`${i===this.dialogue.index?'▶ ':'  '}${choice?.text ?? choice}`,44,height-112+(this.dialogue.text.split('\n').length+i)*26));} }
}
// Commands EventRunner executes natively (move needs a scene move driver the
// fallback has not got, so it is reported as skipped instead of passing through).
const NATIVE_COMMANDS = new Set(['say','ask','wait','setSwitch','setVariable','addVariable','if','goto','call']);
const CANCEL = Symbol('mwgp-fallback-cancel');
const valueOfChoice = choice => choice?.value ?? choice?.text ?? choice;
function directionBit(dx, dy){ if(dy>0)return 0x01; if(dx<0)return 0x02; if(dx>0)return 0x04; return 0x08; }
function tileColor(id){return id?`hsl(${id*47%360} 25% ${28+id%12}%)`:'#18202b';}
