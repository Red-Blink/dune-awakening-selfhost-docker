import { ago, later, capabilities } from './shared';

// Public game house names and reward scales checked against the local server.
// IDs, progress and dates below are fictional; no player contributions are copied.
const houses=['Ecaz','Novebruns','Argosaz','Richese','Sor','Tseida','Wydras','Hagal','Thorvald','Wallach','Vernius','Varota','Moritani','Dyvetz','Lindaren','Mikkarol','Maros','Wayku','Hurata','Mutelli','Taligari','Kenola','Spinette','Alexin','Imota'];
export const landsraadThresholds=[700,3500,7000,10500,14000];
export const landsraadTasks=houses.map((house,index)=>({task_id:String(601+index),board_index:index,house_name:'DA_House'+house,display_name:house,goal_amount:56000,faction_progress:12000+index*1400,completed:false,winning_faction:index%2?'Harkonnen':'Atreides',sysselraad:false}));
export const landsraadRewards=landsraadTasks.flatMap((task,index)=>landsraadThresholds.map((threshold,tier)=>({row_locator:`(${index},${tier+1})`,task_id:task.task_id,threshold,template_id:['SolarisCoin','SandbikeEngine_Unique_Speed_5_Schematic','T6IndustrialPump','Stillsuit_Unique_Efficient_06_Boots_Schematic','Alexin_Placeables_Swatch'][tier],amount:[10000,1,50,1,1][tier]})));
export function landsraadData(url:URL):unknown|undefined {
 if(url.pathname==='/api/admin/landsraad')return {capabilities:{...capabilities,landsraad:true,decrees:true,factionContributions:true,guildContributions:true},term:{term_id:42,start_time:ago(72),end_time:later(96),test_term:false,reigning_faction:'Atreides',active_decree:'ExperienceRateIncrease',elected_decree:'CraftingCostReduced',winning_faction:'Atreides'},decrees:['ExperienceRateIncrease','RangedDamageIncreased','MeleeDamageIncreased','CraftingCostReduced','DropInventoryOnDefeatActive','RepairAndRefiningTimes'].map((name,index)=>({id:index+1,name,weight:1,disabled:false})),tasks:landsraadTasks,rewards:landsraadRewards};
 if(url.pathname==='/api/admin/landsraad/milestone-preset')return {preset:{enabled:true,goalAmount:56000,thresholds:landsraadThresholds,lastAppliedTermId:'42',lastAppliedAt:ago(72),lastResult:'Applied Successfully'}};
}
