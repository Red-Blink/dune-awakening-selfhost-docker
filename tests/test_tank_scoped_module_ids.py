"""Execute the exact generated x86-64 paths with a synthetic FName pool only."""
import importlib.util
import json
from pathlib import Path
import platform
import shutil
import subprocess
import struct
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('scoped', ROOT / 'patches/experimental-tanks/2141883/source/scoped_module_ids.py')
scoped = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scoped)


@unittest.skipUnless(platform.machine() == 'x86_64' and shutil.which('gcc'), 'requires x86-64 assembler')
class ScopedModuleTests(unittest.TestCase):
    def test_compiled_handlers_fit_reviewed_padding(self):
        with tempfile.TemporaryDirectory() as directory:
            symbols, payloads = scoped.compile_payload(Path(directory))
        self.assertEqual(len(payloads), 1)
        address, data = payloads[0]
        self.assertEqual(address, scoped.CAVE)
        self.assertLessEqual(len(data), 231)
        for i in range(3):
            self.assertTrue(address <= symbols[f'site_{i}'] < address+len(data))
        manifest = json.loads((Path(scoped.__file__).resolve().parents[1] / 'manifest.json').read_text())
        patches = {offset: (bytes.fromhex(before), bytes.fromhex(after)) for offset,before,after in manifest['sites']}
        self.assertEqual(patches[address], (b'\xcc'*len(data), data))
        for i,(offset,before,_,_) in enumerate(scoped.SITES):
            original, detour = patches[offset]
            self.assertEqual(original.hex(), before)
            self.assertEqual(offset+5+struct.unpack('<i',detour[1:5])[0], symbols[f'site_{i}'])
        for offset,before,after in scoped.BASE_SITES:
            self.assertEqual(patches[offset], (bytes.fromhex(before),bytes.fromhex(after)))
        self.assertEqual(len(patches), 7)

    def test_actual_instruction_paths_preserve_native_ids_and_tank_compatibility(self):
        wrappers = ['.intel_syntax noprefix\n.text\n']
        for i in range(3):
            name_offset = 24 if i == 0 else 16
            value = 'r9' if i == 0 else 'rax'
            wrappers.append(f'''
.global probe_{i}, return_{i}
probe_{i}:
    push rbp
    mov rbp, rsp
    sub rsp, 160
    push r12
    push r13
    mov r11, rsi
    mov rax, [rdi]
    mov [rbp - 0x98], rax
    lea r12, [rdi + {name_offset}]
    mov r13, [rdi + 16]
    mov rax, 0x778899
    {'lea rax, [rdi + 16]' if i == 2 else ''}
    mov r9, 0x456789
    mov r10, 0x112233
    mov rcx, 0x334455
    mov rdx, 0x556677
    push 0x8d7
    popfq
    jmp site_{i}
return_{i}:
    mov [r11], {value}
    mov [r11 + 8], rcx
    mov [r11 + 16], rdx
    mov [r11 + 24], r10
    mov [r11 + 32], rax
    pushfq
    pop rax
    mov [r11 + 40], rax
    mov rax, [rbp - 0x48]
    mov [r11 + 48], rax
    pop r13
    pop r12
    add rsp, 160
    pop rbp
    ret
''')
        code = r'''
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
unsigned char name_pool[0x68 + 8192*8];
unsigned char name_pool_ready = 1;
static unsigned char entries[512];
extern void probe_0(uint64_t*, uint64_t*);
extern void probe_1(uint64_t*, uint64_t*);
extern void probe_2(uint64_t*, uint64_t*);
static void check(int ok) { if (!ok) { fprintf(stderr,"Scoped instruction assertion failed\n"); exit(1); } }
static void run(const char *name, int tank, int wide, int ready, uint32_t index) {
  memset(entries,0,sizeof(entries));
  uint16_t header = (uint16_t)(strlen(name)*64 + wide);
  memcpy(entries+64,&header,2); memcpy(entries+66,name,strlen(name));
  void *block = entries; memcpy(name_pool+0x68,&block,sizeof(block));
  name_pool_ready = ready;
  uint64_t record[6]={0x123456789abcdefULL,0,index,0x123456789abcdefULL,0,0};
  void (*probes[])(uint64_t*,uint64_t*)={probe_0,probe_1,probe_2};
  for (int i=0;i<3;i++) {
    uint64_t output[7]={0}; probes[i](record,output);
    check(output[0] == (tank ? 0 : record[0]));
    check(output[1]==0x334455 && output[2]==0x556677 && output[3]==0x112233);
    check((output[5]&0x8c5) == (tank ? 0x44 : 0x8c5));
    if(i==0) check(output[4]==0x778899);
    if(i==2) check(output[6]==output[0]);
  }
}
int main(void) {
  const char *tanks[]={"TankChassis","TankEngine","TankGenerator","TankHull", "TankHullFront",
    "TankLocomotionFrontLeft","TankLocomotionFrontRight","TankLocomotionBackLeft",
    "TankLocomotionBackRight","TankBoost","TankStorage","TankDart","TankRocket","TankFlamethrower","tankEngine"};
  const char *native[]={"OrnithopterLightChassis","OrnithopterLightBoost","OrnithopterLightEngine",
    "OrnithopterMediumChassis","SandbikeEngine","TreadwheelGenerator","TreadwheelLocomotion","None","Tan"};
  for(unsigned i=0;i<sizeof(tanks)/sizeof(*tanks);i++)run(tanks[i],1,0,1,32);
  for(unsigned i=0;i<sizeof(native)/sizeof(*native);i++)run(native[i],0,0,1,32);
  run("TankEngine",0,1,1,32); run("TankEngine",0,0,0,32);
  run("TankEngine",0,0,1,8192U<<16);
  puts("All three native and Tank instruction paths passed");
}
'''
        with tempfile.TemporaryDirectory(prefix='dune-tank-instructions-') as directory:
            root = Path(directory)
            (root / 'scope.S').write_text(scoped.assembly() + ''.join(wrappers))
            (root / 'fixture.c').write_text(code)
            subprocess.run(['gcc', '-no-pie', '-o', str(root/'fixture'), str(root/'fixture.c'), str(root/'scope.S')], check=True, capture_output=True)
            result = subprocess.run([str(root/'fixture')], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('All three native and Tank instruction paths passed', result.stdout)


class UpdatedBuildScopedModuleTests(ScopedModuleTests):
    def setUp(self):
        global scoped
        self.previous = scoped
        spec = importlib.util.spec_from_file_location('scoped_new',
            ROOT / 'patches/experimental-tanks/2147284/source/scoped_module_ids.py')
        scoped = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(scoped)

    def tearDown(self):
        global scoped
        scoped = self.previous

    def test_wrong_clean_build_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'exact reviewed clean build'):
            scoped.build(b'wrong executable', {})


class Build2156652ScopedModuleTests(UpdatedBuildScopedModuleTests):
    def setUp(self):
        global scoped
        self.previous = scoped
        spec = importlib.util.spec_from_file_location('scoped_2156652',
            ROOT / 'patches/experimental-tanks/2156652/source/scoped_module_ids.py')
        scoped = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(scoped)


class Build2160922ScopedModuleTests(UpdatedBuildScopedModuleTests):
    def setUp(self):
        global scoped
        self.previous = scoped
        spec = importlib.util.spec_from_file_location('scoped_2160922',
            ROOT / 'patches/experimental-tanks/2160922/source/scoped_module_ids.py')
        scoped = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(scoped)


class Build2162777ScopedModuleTests(UpdatedBuildScopedModuleTests):
    def setUp(self):
        global scoped
        self.previous = scoped
        spec = importlib.util.spec_from_file_location('scoped_2162777',
            ROOT / 'patches/experimental-tanks/2162777/source/scoped_module_ids.py')
        scoped = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(scoped)


class Build2168446ScopedModuleTests(UpdatedBuildScopedModuleTests):
    def setUp(self):
        global scoped
        self.previous = scoped
        spec = importlib.util.spec_from_file_location('scoped_2168446',
            ROOT / 'patches/experimental-tanks/2168446/source/scoped_module_ids.py')
        scoped = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(scoped)


if __name__ == '__main__':
    unittest.main()
