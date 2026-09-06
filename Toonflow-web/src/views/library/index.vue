<template>
  <div class="library-page">
    <div class="library-header"><h2>{{ $t("workbench.menu.assetLibrary") }}</h2><t-space><t-button v-if="!isProjectMode" theme="primary" @click="openUpload"><template #icon><t-icon name="upload" /></template>{{ $t("workbench.assetLibrary.upload") }}</t-button><t-button v-if="!isProjectMode" variant="outline" @click="createFolder"><template #icon><t-icon name="folder-add" /></template>{{ $t("workbench.assetLibrary.newFolder") }}</t-button><t-button v-if="!isProjectMode" theme="primary" variant="outline" :disabled="!selectedIds.size" @click="openImport"><template #icon><t-icon name="arrow-right" /></template>{{ $t("workbench.assetLibrary.importToProject") }}<span v-if="selectedIds.size">&nbsp;({{ selectedIds.size }})</span></t-button></t-space></div>
    <div class="library-body">
      <aside class="folder-pane">
        <div class="pane-title">{{ $t("workbench.assetLibrary.folders") }}</div>
        <t-tree :data="folderTree" :actived="[selectedKey]" :expanded="expandedKeys" activable hover @click="selectNode" />
        <div class="folder-ops" v-if="selectedKey.startsWith('folder-')">
          <t-button variant="text" size="small" @click="renameFolder"><t-icon name="edit" />&nbsp;{{ $t("workbench.assetLibrary.rename") }}</t-button>
          <t-button variant="text" theme="danger" size="small" @click="deleteFolder"><t-icon name="delete" />&nbsp;{{ $t("workbench.assetLibrary.delete") }}</t-button>
        </div>
      </aside>
      <main class="asset-pane">
        <div class="toolbar"><t-input v-model="keyword" clearable :placeholder="$t('workbench.assetLibrary.search')" style="width:280px" @enter="loadAssets" /><t-select v-model="type" clearable :placeholder="$t('workbench.assetLibrary.type')" style="width:150px" :options="typeOptions" @change="reload" /><t-button variant="outline" @click="loadAssets"><t-icon name="search" /></t-button></div>
        <t-loading :loading="loading" show-overlay>
          <div class="asset-grid">
            <div v-for="asset in rows" :key="asset.id" class="asset-card" :class="{ selected: selectedIds.has(asset.id) }">
              <t-checkbox v-if="!isProjectMode" class="asset-check" :checked="selectedIds.has(asset.id)" @change="toggleSelect(asset)" />
              <div class="asset-preview" @click="preview(asset)"><img v-if="mediaKind(asset) === 'image'" :src="assetSrc(asset)" :alt="asset.name" /><video v-else-if="mediaKind(asset) === 'video'" :src="assetSrc(asset)" muted /><t-icon v-else :name="mediaKind(asset) === 'audio' ? 'sound' : 'file-unknown'" size="40" /></div>
              <div class="asset-name" :title="asset.name">{{ asset.name }}</div>
              <div class="asset-actions" v-if="!isProjectMode"><t-button variant="text" size="small" @click="rename(asset)"><t-icon name="edit" /></t-button><t-button variant="text" theme="danger" size="small" @click="remove(asset)"><t-icon name="delete" /></t-button></div>
              <div class="asset-tag" v-else>{{ typeLabel(asset.type) }}</div>
            </div>
            <t-empty v-if="!rows.length && !loading" class="empty" />
          </div>
        </t-loading>
        <t-pagination v-model="page" v-model:page-size="pageSize" :total="total" class="pagination" @change="loadAssets" />
      </main>
    </div>
    <t-dialog v-model:visible="uploadVisible" :header="$t('workbench.assetLibrary.upload')" :confirm-btn="null" :cancel-btn="null">
      <t-form :data="uploadForm" @submit="upload">
        <t-form-item :label="$t('workbench.assetLibrary.uploadToFolder')" name="folderId"><t-select v-model="uploadForm.folderId" :options="folderOptions" clearable /></t-form-item>
        <t-form-item :label="$t('workbench.assetLibrary.name')" name="name"><t-input v-model="uploadForm.name" :placeholder="uploadFiles.length > 1 ? $t('workbench.assetLibrary.multiFileHint') : ''" /></t-form-item>
        <t-form-item :label="$t('workbench.assetLibrary.type')" name="type"><t-select v-model="uploadForm.type" :options="types" /></t-form-item>
        <t-form-item :label="$t('workbench.assetLibrary.file')"><input type="file" multiple accept="image/*,audio/*,video/*" @change="chooseFile" /></t-form-item>
        <t-form-item><t-space><t-button theme="primary" type="submit" :loading="uploading">{{ $t('common.confirm') }}</t-button><t-button @click="uploadVisible=false">{{ $t('common.cancel') }}</t-button></t-space></t-form-item>
      </t-form>
    </t-dialog>
    <t-dialog v-model:visible="importVisible" :header="$t('workbench.assetLibrary.importToProject')" :confirm-btn="null" :cancel-btn="null">
      <t-form>
        <t-form-item :label="$t('workbench.assetLibrary.chooseTargetProject')"><t-select v-model="importTargetProjectId" :options="projectOptions" style="width:100%" /></t-form-item>
      </t-form>
      <div class="picker-footer"><t-button theme="primary" :loading="importing" :disabled="!importTargetProjectId" @click="importToProject">{{ $t('workbench.assetLibrary.import') }}</t-button><t-button @click="importVisible=false">{{ $t('common.cancel') }}</t-button></div>
    </t-dialog>
  </div>
</template>
<script setup lang="ts">
import axios from "@/utils/axios";
import { MessagePlugin } from "tdesign-vue-next";
interface Asset { id:number; name:string; mimeType?:string; url?:string; src?:string; type?:string; }
const selectedKey=ref<string>("all"), folders=ref<any[]>([]), projects=ref<any[]>([]), rows=ref<Asset[]>([]), loading=ref(false), keyword=ref(""), type=ref(""), page=ref(1), pageSize=ref(20), total=ref(0), uploadVisible=ref(false), uploading=ref(false), uploadFiles=ref<File[]>([]);
const uploadForm=reactive({name:"",type:"image",folderId:undefined as number|undefined});
const selectedIds=ref<Set<number>>(new Set());
const importVisible=ref(false), importing=ref(false), importTargetProjectId=ref<number|undefined>();
const libraryTypes=[{label:$t("workbench.assetLibrary.image"),value:"image"},{label:$t("workbench.assetLibrary.role"),value:"role"},{label:$t("workbench.assetLibrary.tool"),value:"tool"},{label:$t("workbench.assetLibrary.scene"),value:"scene"},{label:$t("workbench.assetLibrary.audio"),value:"audio"},{label:$t("workbench.assetLibrary.video"),value:"video"}];
const types=libraryTypes;
const projectTypes=[{label:$t("workbench.assetLibrary.all"),value:""},{label:$t("workbench.assetLibrary.role"),value:"role"},{label:$t("workbench.assetLibrary.tool"),value:"tool"},{label:$t("workbench.assetLibrary.scene"),value:"scene"},{label:$t("workbench.assetLibrary.clip"),value:"clip"},{label:$t("workbench.assetLibrary.audio"),value:"audio"}];
const isProjectMode=computed(()=>selectedKey.value.startsWith("project-"));
const projectId=computed(()=>isProjectMode.value?Number(selectedKey.value.slice("project-".length)):null);
const typeOptions=computed(()=>isProjectMode.value?projectTypes:libraryTypes);
const typeLabelMap:Record<string,string>={role:$t("workbench.assetLibrary.role"),tool:$t("workbench.assetLibrary.tool"),scene:$t("workbench.assetLibrary.scene"),clip:$t("workbench.assetLibrary.clip"),audio:$t("workbench.assetLibrary.audio"),video:$t("workbench.assetLibrary.video")};
function typeLabel(value?:string){return typeLabelMap[value?? ""]?? (value?? "")}
const folderTree=computed(()=>[
  {label:$t("workbench.assetLibrary.projects"),value:"projects",children:projects.value.map(p=>({label:p.name,value:`project-${p.id}`}))},
  {label:$t("workbench.assetLibrary.myFolders"),value:"folders",children:[{label:$t("workbench.assetLibrary.all"),value:"all"},...folders.value.filter(f=>!f.parentId).map(toNode)]},
]);
function toNode(f:any):any{return {label:f.name,value:`folder-${f.id}`,children:folders.value.filter(x=>x.parentId===f.id).map(toNode)}}
const expandedKeys=computed(()=>["projects","folders","all",...folders.value.map(f=>`folder-${f.id}`),...projects.value.map(p=>`project-${p.id}`)]);
const folderOptions=computed(()=>[{label:$t("workbench.assetLibrary.rootFolder"),value:undefined},...flattenFolders(null,0).map(f=>({label:f.label,value:f.id}))]);
function flattenFolders(parentId:number|null,depth:number):any[]{return folders.value.filter(f=>f.parentId===parentId).flatMap(f=>[{id:f.id,label:`${"— ".repeat(depth)}${f.name}`},...flattenFolders(f.id,depth+1)])}
const projectOptions=computed(()=>projects.value.map(p=>({label:p.name,value:p.id})));
function assetSrc(asset:Asset){return asset.src||asset.url||""}
function mediaKind(asset:Asset):"image"|"video"|"audio"|"file"{
  if(asset.mimeType?.startsWith("image/")||(!asset.mimeType&&["role","tool","scene"].includes(asset.type??"")))return "image";
  if(asset.mimeType?.startsWith("video/"))return "video";
  if(asset.mimeType?.startsWith("audio/"))return "audio";
  if(asset.type==="audio")return "audio";
  if(asset.type==="clip"&&/\.(mp4|webm|mov)(\?|$)/i.test(assetSrc(asset)))return "video";
  return "file";
}
async function loadProjects(){try{const {data}=await axios.post("/project/getProject",{});projects.value=(Array.isArray(data)?data:data?.data)||[].slice().sort((a:any,b:any)=>b.createTime-a.createTime)}catch{}}
async function loadFolders(){const {data}=await axios.get("/library/folders");folders.value=data.data||[]}
async function loadAssets(){loading.value=true;try{
  if(isProjectMode.value){
    const {data}=await axios.post("/assets/getAssetsApi",{projectId:projectId.value,type:type.value||undefined,name:keyword.value||undefined,page:page.value,limit:pageSize.value});
    rows.value=data.data||[];total.value=Number(data.total)||0;
  }else{
    const folderId=selectedKey.value.startsWith("folder-")?Number(selectedKey.value.slice("folder-".length)):null;
    const {data}=await axios.get("/library-assets",{params:{folderId:folderId||undefined,keyword:keyword.value||undefined,type:type.value||undefined,page:page.value,limit:pageSize.value}});
    rows.value=data.data||[];total.value=data.total||0;
  }
  selectedIds.value=new Set();
}finally{loading.value=false}}
function reload(){page.value=1;loadAssets()}
function selectNode(e:any){const value:string=e.node?.value;if(value==null||value==="projects"||value==="folders")return;selectedKey.value=value;keyword.value="";type.value="";page.value=1;loadAssets()}
function toggleSelect(asset:Asset){const next=new Set(selectedIds.value);if(next.has(asset.id))next.delete(asset.id);else next.add(asset.id);selectedIds.value=next}
function openUpload(){uploadForm.name="";uploadForm.type="image";uploadForm.folderId=selectedKey.value.startsWith("folder-")?Number(selectedKey.value.slice("folder-".length)):undefined;uploadFiles.value=[];uploadVisible.value=true}
function chooseFile(e:Event){const files=Array.from((e.target as HTMLInputElement).files??[]);uploadFiles.value=files;if(files.length===1&&!uploadForm.name)uploadForm.name=files[0].name}
function readFile(f:File){return new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=reject;r.readAsDataURL(f)})}
async function upload(){if(!uploadFiles.value.length)return MessagePlugin.warning($t("workbench.assetLibrary.chooseFile"));uploading.value=true;try{
  let failed=0;
  for(const f of uploadFiles.value){
    try{await axios.post("/library-assets/upload",{name:uploadFiles.value.length===1&&uploadForm.name?uploadForm.name:f.name,type:uploadForm.type,folderId:uploadForm.folderId ?? null,base64Data:await readFile(f)})}
    catch{failed+=1}
  }
  const okCount=uploadFiles.value.length-failed;
  if(failed)MessagePlugin.warning(`${okCount}/${uploadFiles.value.length} ${$t("workbench.assetLibrary.uploadSuccess")}`);
  else MessagePlugin.success($t("workbench.assetLibrary.uploadSuccess"));
  uploadVisible.value=false;reload()
}finally{uploading.value=false}}
async function rename(asset:Asset){const name=prompt($t("workbench.assetLibrary.rename"),asset.name);if(name?.trim()){await axios.patch(`/library-assets/${asset.id}`,{name:name.trim()});loadAssets()}}
async function remove(asset:Asset){if(confirm($t("workbench.assetLibrary.deleteConfirm"))){await axios.delete(`/library-assets/${asset.id}`);loadAssets()}}
async function renameFolder(){const id=Number(selectedKey.value.slice("folder-".length));const folder=folders.value.find(f=>f.id===id);const name=prompt($t("workbench.assetLibrary.rename"),folder?.name??"");if(name?.trim()){await axios.patch(`/library/folders/${id}`,{name:name.trim()});await loadFolders()}}
async function deleteFolder(){const id=Number(selectedKey.value.slice("folder-".length));if(!confirm($t("workbench.assetLibrary.deleteFolderConfirm")))return;try{await axios.delete(`/library/folders/${id}`);selectedKey.value="all";await loadFolders();reload()}catch(error:any){MessagePlugin.error(error?.response?.data?.message??error?.message??"删除失败")}}
function preview(asset:Asset){const src=assetSrc(asset);if(!src)return;if(mediaKind(asset)==="audio"){const audio=new Audio(src);audio.play()}else window.open(src,"_blank")}
async function createFolder(){const name=prompt($t("workbench.assetLibrary.folderName"));if(name?.trim()){const folderId=selectedKey.value.startsWith("folder-")?Number(selectedKey.value.slice("folder-".length)):null;await axios.post("/library/folders",{name:name.trim(),parentId:folderId});await loadFolders()}}
// 将手动目录中选中的资产复制引入到目标项目（按类型自动映射，逐组调用引入接口）
function targetTypeOf(t?:string){if(t==="audio")return"audio";if(["video","clip"].includes(t??""))return"clip";if(t==="tool")return"tool";if(t==="scene")return"scene";return"role"}
function openImport(){importTargetProjectId.value=undefined;importVisible.value=true}
async function importToProject(){if(!importTargetProjectId.value)return;importing.value=true;try{
  const groups=new Map<string,number[]>();
  rows.value.filter(a=>selectedIds.value.has(a.id)).forEach(a=>{const t=targetTypeOf(a.type);groups.set(t,[...(groups.get(t)??[]),a.id])});
  let ok=0,fail=0;
  for(const [t,ids] of groups){
    const {data}=await axios.post("/assets/importFromLibrary",{projectId:importTargetProjectId.value,libraryAssetIds:ids,type:t});
    const results=data.data?.results??data.results??[];
    ok+=results.filter((r:any)=>r.success).length;fail+=results.filter((r:any)=>!r.success).length;
  }
  const total2=ok+fail;
  if(fail)MessagePlugin.warning(`${ok}/${total2} ${$t("workbench.assetLibrary.importSuccess")}`);
  else MessagePlugin.success(`${ok}/${total2} ${$t("workbench.assetLibrary.importSuccess")}`);
  importVisible.value=false;selectedIds.value=new Set();loadAssets()
}catch(error:any){MessagePlugin.error(error?.response?.data?.message??error?.message??"导入失败")}finally{importing.value=false}}
function refreshMeta(){loadProjects();loadFolders()}
onMounted(()=>{refreshMeta();loadAssets();window.addEventListener("focus",refreshMeta);document.addEventListener("visibilitychange",refreshMeta)})
onUnmounted(()=>{window.removeEventListener("focus",refreshMeta);document.removeEventListener("visibilitychange",refreshMeta)})
</script>
<style scoped>.library-page{height:100%;padding:24px;background:var(--td-bg-color-page)}.library-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}.library-body{display:flex;height:calc(100% - 70px);background:var(--td-bg-color-container);border-radius:8px}.folder-pane{width:240px;border-right:1px solid var(--td-component-border);padding:18px;overflow:auto;display:flex;flex-direction:column}.folder-ops{margin-top:12px;display:flex;gap:4px}.pane-title{font-weight:600;margin-bottom:14px}.asset-pane{flex:1;padding:18px;overflow:auto}.toolbar{display:flex;gap:12px;margin-bottom:18px}.asset-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:16px;min-height:300px}.asset-card{border:1px solid var(--td-component-border);border-radius:6px;padding:10px;position:relative}.asset-card.selected{border-color:var(--td-brand-color)}.asset-check{position:absolute;top:6px;left:6px;z-index:2;background:rgba(255,255,255,.8);border-radius:4px;padding:2px}.asset-preview{height:130px;display:flex;align-items:center;justify-content:center;background:var(--td-bg-color-secondarycontainer);cursor:pointer}.asset-preview img,.asset-preview video{max-width:100%;max-height:100%}.asset-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:8px}.asset-actions{text-align:right}.asset-tag{margin-top:4px;font-size:12px;color:var(--td-text-color-secondary);text-align:right}.pagination{margin-top:18px}.empty{grid-column:1/-1}.picker-footer{display:flex;justify-content:flex-end;gap:8px}</style>
