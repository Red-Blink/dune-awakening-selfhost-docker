export function playerHistory(name:string) {
 return ['Grant Items','Set Skill Modules','Teleport'].map((action,index)=>({'Date / Time':new Date(Date.now()-(index+1)*3600000).toLocaleString(),Admin:'Sample Admin','Action Type':action,Target:name,Amount:String(index+1),Notes:'Succeeded'}));
}
