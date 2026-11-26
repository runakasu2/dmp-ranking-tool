// The upstream form uses the raw API spelling. This representation is only
// for comparing an HTML heading or rendering a name as plain text.
export function comparisonName(raw,{htmlHeading=false}={}) {
  if (/&amp;(?:amp;|#)/i.test(raw)) return null;
  let invalid=false;
  const decoded=raw.replace(/&#(?:[0-9]+|[xX][0-9a-fA-F]+);|&#/g,reference=>{
    const token=reference.slice(2,-1);
    const hex=/^x/i.test(token);
    const code=hex?Number.parseInt(token.slice(1),16):Number(token);
    if(!token||!Number.isInteger(code)||code<32||code>0x10FFFF||
      (code>=0x7F&&code<=0x9F)||(code>=0xD800&&code<=0xDFFF)||
      (code>=0xFDD0&&code<=0xFDEF)||(code&0xFFFF)>=0xFFFE) {
      invalid=true;
      return reference;
    }
    return String.fromCodePoint(code);
  });
  if(invalid||(decoded!==raw&&(htmlHeading?/&#|&amp;#/i:/&(?:#|[a-z][a-z\d]*;)/i).test(decoded))) return null;
  return decoded;
}

export const displayName=raw=>comparisonName(raw)??raw;

export async function hasNameCollision(db,dmpId,expected) {
  const {rows}=await db.query(`SELECT handle_name FROM players WHERE dmp_id<>$1
    AND (strpos(handle_name,'&')>0 OR strpos(handle_name,$2)>0)`,[dmpId,expected]);
  return rows.some(row=>comparisonName(row.handle_name.trim())===expected);
}
