import { createHash } from 'node:crypto';

/** Private derived representation. The original HTML remains unchanged in BrowserMailMessage.content. */
export interface CrmControlMailText {
  format: 'plain' | 'html'; text: string; quotedText: string; textSha256: string;
  eligibleAsSemanticText: boolean; reasonCodes: string[];
}
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const blocks = new Set(['p','div','br','hr','li','ul','ol','table','tr','td','th','thead','tbody','tfoot','h1','h2','h3','h4','h5','h6','pre']);
const allowedTags = new Set(['html','body','p','div','span','br','hr','a','b','strong','i','em','u','s','strike','font','li','ul','ol','table','tr','td','th','thead','tbody','tfoot','h1','h2','h3','h4','h5','h6','pre','blockquote']);
const voidTags = new Set(['br','hr']);
const quoteClasses = new Set(['gmail_quote','gmail_quote_container','yahoo_quoted','moz-cite-prefix']);
const quoteIds = new Set(['divrplyfwdmsg','appendonsend']);
const normalized = (value: string) => value.replace(/\r\n?/g, '\n').replace(/[\t \u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
function decode(text: string, reasons: Set<string>) {
  const named: Record<string, string> = { amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ' };
  return text.replace(/&(?:#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, entity => {
    const key = entity.slice(1,-1);
    if (Object.hasOwn(named,key)) return named[key];
    if (key[0] === '#') {
      const number = key[1]?.toLowerCase() === 'x' ? Number.parseInt(key.slice(2),16) : Number.parseInt(key.slice(1),10);
      if (number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)) return String.fromCodePoint(number);
    }
    reasons.add('MAIL_TEXT_ENTITY_UNSUPPORTED'); return entity;
  });
}
function splitPlainQuote(value: string): {text:string;quotedText:string;inline:boolean} {
  const lines=value.split('\n');let cutoff=-1, lineQuote=false, inline=false;
  for(let i=0;i<lines.length;i++) {
    const line=lines[i].trim();
    const header=/^(?:-{2,}\s*(?:original message|forwarded message|исходное сообщение|пересылаемое сообщение).*-{2,}|begin forwarded message:|начало переадресованного сообщения:)/i.test(line)
      || /^On .{1,500} wrote:$/i.test(line) || /^.{1,500}(?:писал|писала|написал|написала)(?:\([а-я]\))?:$/i.test(line)
      || /^(?:From|От):/i.test(line) && lines.slice(i+1,i+6).filter(next=>/^(?:Sent|To|Subject|Date|Отправлено|Кому|Тема|Дата):/i.test(next.trim())).length >= 2;
    if(header) {cutoff=i;break;}
    if(/^>/.test(line)) {cutoff=i;lineQuote=true;break;}
  }
  if(cutoff<0)return {text:value,quotedText:'',inline:false};
  if(lineQuote) inline=lines.slice(cutoff+1).some(line=>line.trim() && !/^\s*>/.test(line));
  return {text:lines.slice(0,cutoff).join('\n'),quotedText:lines.slice(cutoff).join('\n'),inline};
}

/** Bounded strict subset, not a browser renderer. Unsupported structure remains in the raw archive and is not attributed. */
export function normalizeCrmControlMailText(content: string): CrmControlMailText {
  const reasons=new Set<string>();
  const format: 'plain'|'html'=/<\/?[a-z][\s\S]*?>|<!--/i.test(content)?'html':'plain';
  let text='',quotedText='';
  if(typeof content!=='string' || content.length>200_000) reasons.add('MAIL_TEXT_LIMIT');
  else if(format==='plain') {
    const split=splitPlainQuote(content.replace(/\r\n?/g,'\n'));text=split.text;quotedText=split.quotedText;
    if(split.inline)reasons.add('MAIL_INLINE_REPLY_UNVERIFIED');
  } else {
    const stack:Array<{tag:string;quote:boolean}>=[];
    let index=0,quoteStarted=false;
    const append=(value:string)=>{
      const decoded=decode(value,reasons),inQuote=stack.some(item=>item.quote);
      if(quoteStarted) {
        quotedText+=decoded;
        if(!inQuote && decoded.trim())reasons.add('MAIL_INLINE_REPLY_UNVERIFIED');
      } else text+=decoded;
    };
    while(index<content.length) {
      const open=content.indexOf('<',index);
      if(open<0){append(content.slice(index));break;}
      append(content.slice(index,open));
      if(content.startsWith('<!--',open)) {
        const end=content.indexOf('-->',open+4);
        if(end<0){reasons.add('MAIL_HTML_MALFORMED');break;}
        if(/\[if\b|\[endif\]/i.test(content.slice(open,end)))reasons.add('MAIL_HTML_CONDITIONAL_UNVERIFIED');
        index=end+3;continue;
      }
      let end=open+1,quote='';
      for(;end<content.length && end-open<8192;end++) {
        const c=content[end];if(quote){if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c==='>')break;
      }
      if(content[end]!=='>' || quote){reasons.add('MAIL_HTML_MALFORMED');break;}
      const token=content.slice(open,end+1),close=/^<\s*\/\s*([a-z][a-z0-9]*)\s*>$/i.exec(token);
      index=end+1;
      if(close) {
        const tag=close[1].toLowerCase();
        if(stack.at(-1)?.tag!==tag){reasons.add('MAIL_HTML_MALFORMED');break;}
        if(blocks.has(tag)||tag==='blockquote')append('\n');stack.pop();continue;
      }
      const start=/^<([a-z][a-z0-9]*)([\s\S]*?)\s*\/?>$/i.exec(token);
      if(!start || !allowedTags.has(start[1].toLowerCase())){reasons.add('MAIL_HTML_TAG_UNSUPPORTED');break;}
      const tag=start[1].toLowerCase(),attributes:Record<string,string>={};
      const raw=start[2].replace(/\s*\/$/,'');let offset=0;
      while(offset<raw.length) {
        if(!raw.slice(offset).trim())break;
        const attr=/^\s+([a-z][a-z0-9_:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+)))?/i.exec(raw.slice(offset));
        if(!attr){reasons.add('MAIL_HTML_ATTRIBUTE_UNSUPPORTED');break;}
        const key=attr[1].toLowerCase();if(Object.hasOwn(attributes,key))reasons.add('MAIL_HTML_ATTRIBUTE_UNSUPPORTED');
        attributes[key]=decode(attr[2]??attr[3]??attr[4]??'',reasons);offset+=attr[0].length;
      }
      if(Object.keys(attributes).some(key=>key.startsWith('on')||['hidden','aria-hidden','contenteditable'].includes(key)))reasons.add('MAIL_HTML_HIDDEN_OR_ACTIVE_CONTENT');
      if(attributes.style && /(?:display|visibility|opacity|content|position|overflow|font-size\s*:\s*0|color\s*:\s*transparent)/i.test(attributes.style))reasons.add('MAIL_HTML_STYLE_UNVERIFIED');
      if(blocks.has(tag)||tag==='blockquote')append('\n');
      const isQuote=tag==='blockquote'||attributes.type==='cite'||(attributes.class??'').toLowerCase().split(/\s+/).some(c=>quoteClasses.has(c))||quoteIds.has((attributes.id??'').toLowerCase());
      if(isQuote)quoteStarted=true;
      if(!voidTags.has(tag)) {
        if(/\/\s*>$/.test(token)){reasons.add('MAIL_HTML_MALFORMED');break;}
        if(stack.length>=100){reasons.add('MAIL_HTML_DEPTH_LIMIT');break;}
        stack.push({tag,quote:isQuote});
      }
    }
    if(stack.length)reasons.add('MAIL_HTML_MALFORMED');
    const split=splitPlainQuote(text);text=split.text;quotedText=split.quotedText+(split.quotedText&&quotedText?'\n':'')+quotedText;
    if(split.inline)reasons.add('MAIL_INLINE_REPLY_UNVERIFIED');
  }
  text=normalized(text);quotedText=normalized(quotedText);
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069]/.test(text))reasons.add('MAIL_TEXT_INVISIBLE_CONTROL');
  if(text.length>50_000)reasons.add('MAIL_TEXT_LIMIT');
  if(!text)reasons.add('MAIL_CURRENT_TEXT_EMPTY');
  return {format,text,quotedText,textSha256:hash(text),eligibleAsSemanticText:reasons.size===0,reasonCodes:[...reasons]};
}
