import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlayerDetailTab } from './PlayerDetailTab';
vi.mock('../../api/admin',()=>({adminApi:{itemCatalog:vi.fn().mockResolvedValue({rows:[]})}}));
const row={id:'18492071',item_name:'Plant Fiber',template_id:'PlantFiber',stack_size:150,quality_level:0,position_index:0,current_durability:null,max_durability:null,augments:[]};
function show(variant:'standard'|'schematics'='standard'){
 return render(<PlayerDetailTab playerId="101" data={{capabilities:{inventory:true}}} rows={[row]} emptyMessage="No items" onReload={vi.fn()} onError={vi.fn()} confirmAction={vi.fn().mockResolvedValue(false)} formatMutationResult={()=>''} variant={variant}/>);
}
describe('inventory template information',()=>{
 it.each(['standard','schematics'] as const)('uses a portal tooltip for %s items, with keyboard and touch access',async variant=>{
  show(variant);
  const trigger=screen.getByRole('button',{name:'About Plant Fiber'});
  expect(trigger).toHaveAttribute('aria-expanded','false');
  fireEvent.focus(trigger);
  await waitFor(()=>expect(trigger).toHaveAttribute('aria-expanded','true'));
  const tooltip=screen.getByRole('tooltip');
  expect(tooltip).toHaveTextContent('Template ID: PlantFiber');
  expect(tooltip.parentElement).toBe(document.body);
  expect(trigger).toHaveAttribute('aria-describedby',tooltip.id);
  fireEvent.keyDown(document,{key:'Escape'});
  expect(trigger).toHaveAttribute('aria-expanded','false');
  fireEvent.pointerEnter(trigger.parentElement!,{pointerType:'touch'});
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded','true');
  fireEvent.pointerDown(document.body);
  expect(trigger).toHaveAttribute('aria-expanded','false');
 });
});
