<template>
  <t-dialog v-model:visible="visible" :header="$t('workbench.assetLibrary.importTitle')" width="960px" :confirm-btn="null" :cancel-btn="null">
    <div class="picker-toolbar">
      <t-radio-group v-model="source" variant="default-filled" @change="switchSource">
        <t-radio-button value="library">{{ $t('workbench.menu.assetLibrary') }}</t-radio-button>
        <t-radio-button value="project">{{ $t('workbench.assetLibrary.sourceProjects') }}</t-radio-button>
      </t-radio-group>
      <t-select v-if="source === 'project'" v-model="sourceProjectId" :placeholder="$t('workbench.assetLibrary.chooseProject')" :options="projectOptions" style="width:220px" @change="reload" />
      <t-input v-model="keyword" clearable :placeholder="$t('workbench.assetLibrary.search')" @enter="reload" />
      <t-button @click="reload"><t-icon name="search" /></t-button>
    </div>
    <div class="picker-body">
      <aside class="picker-folders" v-if="source === 'library'">
        <t-tree :data="folderTree" :actived="[folderKey]" :expanded="expandedKeys" activable hover @click="selectFolder" />
      </aside>
      <div class="picker-table">
        <t-table row-key="id" :data="assets" :columns="columns" :selected-row-keys="selected" :loading="loading" @select-change="handleSelectChange">
          <template #preview="{ row }"><img v-if="previewSrc(row)" :src="previewSrc(row)" :alt="row.name" class="asset-preview" /><t-icon v-else name="file" /></template>
          <template #kind="{ row }">{{ kindLabel(row) }}</template>
        </t-table>
      </div>
    </div>
    <div class="picker-footer"><t-button theme="primary" :loading="importing" :disabled="!selected.length" @click="importAssets">{{ $t('workbench.assetLibrary.import') }}</t-button><t-button @click="visible=false">{{ $t('common.cancel') }}</t-button></div>
  </t-dialog>
</template>
<script setup lang="ts">
import { ref, computed, watch } from "vue";
import axios from "@/utils/axios";
import { MessagePlugin, type TableProps } from "tdesign-vue-next";
const props=defineProps<{projectId:number;type:string}>(); const visible=defineModel<boolean>({default:false}); const emit=defineEmits<{done:[]}>();
const assets=ref<any[]>([]),selected=ref<(string|number)[]>([]),keyword=ref(""),loading=ref(false),importing=ref(false),source=ref<"library"|"project">("library"),sourceProjectId=ref<number | undefined>(),projects=ref<any[]>([]),folders=ref<any[]>([]),folderKey=ref<string>("all");
const projectTypeMap:Record<string,string>={role:"role",tool:"tool",scene:"scene",clip:"clip",audio:"audio"};
// 图片资产默认 type=image，角色/道具/场景 Tab 同时匹配 image，保证默认上传的图片可被引入
const libraryTypeMap:Record<string,string>={role:"role,image",tool:"tool,image",scene:"scene,image",clip:"video,clip",audio:"audio"};
const columns=computed<TableProps["columns"]>(()=>[
  {colKey:"row-select",type:"multiple",width:50},
  {colKey:"preview",title:$t("workbench.assets.preview"),width:80},
  {colKey:"name",title:$t("workbench.assetLibrary.name")},
  {colKey:"kind",title:$t("workbench.assetLibrary.type"),width:90},
]);
const expandedKeys=computed(()=>["all",...folders.value.map(f=>`folder-${f.id}`)]);
const projectOptions=computed(()=>projects.value.filter(p=>p.id!==props.projectId).map(p=>({label:p.name,value:p.id})));
const folderTree=computed(()=>[{label:$t("workbench.assetLibrary.all"),value:"all"},...folders.value.filter(f=>!f.parentId).map(toNode)]);
function toNode(f:any):any{return {label:f.name,value:`folder-${f.id}`,children:folders.value.filter(x=>x.parentId===f.id).map(toNode)}}
function previewSrc(row:any){if(source.value==="library")return row.mimeType?.startsWith("image/")?row.url:"";return ["role","tool","scene"].includes(row.type)?row.src:""}
function kindLabel(row:any){return source.value==="library"?(row.mimeType??""):(row.type??"")}
function handleSelectChange(keys:(string|number)[]){selected.value=keys}
function switchSource(){selected.value=[];assets.value=[];if(source.value==="project"&&!sourceProjectId.value){const first=projectOptions.value[0];if(first)sourceProjectId.value=first.value as number}reload()}
function selectFolder(e:any){const value:string=e.node?.value;if(value==null)return;folderKey.value=value;selected.value=[];reload()}
function reload(){if(source.value==="project"&&!sourceProjectId.value){assets.value=[];return}load()}
async function load(){loading.value=true;try{
  if(source.value==="library"){
    const folderId=folderKey.value.startsWith("folder-")?Number(folderKey.value.slice("folder-".length)):null;
    const {data}=await axios.get("/library-assets",{params:{folderId:folderId||undefined,keyword:keyword.value||undefined,type:libraryTypeMap[props.type],page:1,limit:100}});
    assets.value=data.data?.data ?? data.data ?? [];
  }else{
    const {data}=await axios.post("/assets/getAssetsApi",{projectId:sourceProjectId.value,type:projectTypeMap[props.type]??props.type,name:keyword.value||undefined,page:1,limit:100});
    assets.value=(data.data||[]).map((row:any)=>({...row,sonAssets:undefined}));
  }
}catch(error:any){MessagePlugin.error(error?.message?? "加载资产失败")}finally{loading.value=false}}
async function loadProjects(){try{const {data}=await axios.post("/project/getProject",{});projects.value=(Array.isArray(data)?data:data?.data)||[]}catch{}}
async function loadFolders(){try{const {data}=await axios.get("/library/folders");folders.value=data.data||[]}catch{}}
async function importAssets(){importing.value=true;try{
  let results:any[]=[];
  if(source.value==="library"){
    const {data}=await axios.post("/assets/importFromLibrary",{projectId:props.projectId,libraryAssetIds:selected.value.map(Number),type:props.type});
    results=data.data?.results ?? data.results ?? [];
  }else{
    const {data}=await axios.post("/assets/importFromProject",{projectId:props.projectId,sourceProjectId:sourceProjectId.value,assetIds:selected.value.map(Number)});
    results=data.data?.results ?? data.results ?? [];
  }
  const succeeded=results.filter((x:any)=>x.success).length;
  MessagePlugin.success(`${succeeded}/${selected.value.length} ${$t('workbench.assetLibrary.importSuccess')}`);
  visible.value=false;emit("done")
}catch(error:any){MessagePlugin.error(error?.message ?? "导入资产失败")}finally{importing.value=false}}
watch(visible,(v)=>{if(v){selected.value=[];source.value="library";sourceProjectId.value=undefined;folderKey.value="all";keyword.value="";loadProjects();loadFolders();load()}})
</script>
<style scoped>.picker-toolbar{display:flex;gap:8px;margin-bottom:12px;align-items:center}.picker-body{display:flex;gap:12px}.picker-folders{width:180px;border-right:1px solid var(--td-component-border);padding-right:8px;max-height:420px;overflow:auto}.picker-table{flex:1}.picker-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.asset-preview{width:48px;height:48px;object-fit:cover;border-radius:4px}</style>
