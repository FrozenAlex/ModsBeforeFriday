import { useRef, useState } from "react";
import { useLog } from "./LogWindow";
import { Mod, trimGameVersion } from "../Models";
import { ErrorModal, Modal, SyncingModal } from "./Modal";
import { Adb } from '@yume-chan/adb';
import { ModCard } from "./ModCard";
import UploadIcon from '../icons/upload.svg';
import ToolsIcon from '../icons/tools-icon.svg';
import '../css/ModManager.css';
import { importFile, importUrl, removeMod, setModStatuses } from "../Agent";
import { toast } from "react-toastify";
import { ModRepoBrowser } from "./ModRepoBrowser";
import { ImportResult, ImportResultType, ImportedMod, ModStatus } from "../Messages";
import { OptionsMenu } from "./OptionsMenu";
import useFileDropper from "../hooks/useFileDropper";
import { LogEventSink, logInfo } from "../Agent";

interface ModManagerProps {
    gameVersion: string,
    setMods: (mods: Mod[]) => void,
    modStatus: ModStatus,
    setModStatus: (status: ModStatus) => void,
    device: Adb,
    quit: (err: unknown) => void
}

type SelectedMenu = 'add' | 'current' | 'options';

export function ModManager(props: ModManagerProps) {
    const { modStatus, setModStatus, setMods, device, gameVersion, quit } = props;
    const mods = modStatus.installed_mods;

    const [isWorking, setWorking] = useState(false);
    const [logEvents, addLogEvent] = useLog();
    const [modError, setModError] = useState(null as string | null);
    const [menu, setMenu] = useState('add' as SelectedMenu)
    sortById(mods);

    return <>
        <Title menu={menu} setMenu={setMenu}/>
        
        {/* We use a style with display: none when hiding this menu, as this avoids remounting the component,
            which would fetch the mods index again. */}
        <div className={menu === 'add' ? "" : "hidden"}>
            <AddModsMenu
                mods={mods}
                setMods={setMods}
                setWorking={working => setWorking(working)}
                gameVersion={gameVersion}
                setError={err => setModError(err)}
                device={device}
                addLogEvent={addLogEvent}
            />
        </div>
        
        <div className={menu === 'current' ? "" : "hidden"}>
            <InstalledModsMenu
                mods={mods}
                setMods={setMods}
                setWorking={working => setWorking(working)}
                gameVersion={gameVersion}
                setError={err => setModError(err)}
                device={device}
                addLogEvent={addLogEvent}
            />
        </div>
        
        <div className={menu === 'options' ? "" : "hidden"}>
            <OptionsMenu
                device={device}
                quit={quit}
                modStatus={modStatus}
                setModStatus={setModStatus}
            />    
        </div>
        
        <ErrorModal isVisible={modError != null}
            title={"Failed to sync mods"}
            description={modError!}
            onClose={() => setModError(null)} />
        <SyncingModal isVisible={isWorking} title="Syncing Mods..." logEvents={logEvents} />
    </>
}

interface TitleProps {
    menu: SelectedMenu,
    setMenu: (menu: SelectedMenu) => void
}

function Title(props: TitleProps) {
    const { menu, setMenu } = props;

    return <div className='container noPadding horizontalCenter'>
        <div className={`tab-header ${menu === 'current' ? "selected":""}`}
            onClick={() => setMenu('current')}>
            <h1>Your Mods</h1>
        </div>
        <span className={`tab-header settingsCog ${menu === 'options' ? "selected":""}`}
            onClick={() => setMenu('options')}>
            <img src={ToolsIcon} />
        </span>
        <div className={`tab-header ${menu === 'add' ? "selected":""}`}
            onClick={() => setMenu('add')}>
            <h1>Add Mods</h1>
        </div>
    </div>
}

interface ModMenuProps {
    mods: Mod[],
    setMods: (mods: Mod[]) => void,
    gameVersion: string,
    setWorking: (working: boolean) => void,
    setError: (err: string) => void,
    addLogEvent: LogEventSink,
    device: Adb
}

function InstalledModsMenu(props: ModMenuProps) {
    const { mods,
        setMods,
        gameVersion,
        setWorking,
        setError,
        addLogEvent,
        device
    } = props;

    const [changes, setChanges] = useState({} as { [id: string]: boolean });
    const hasChanges = Object.keys(changes).length > 0;

    return <div className="installedModsMenu">
        {hasChanges && <button id="syncButton" onClick={async () => {
            setChanges({});
            console.log("Installing mods, statuses requested: " + JSON.stringify(changes));
            try {
                setWorking(true);
                const updatedMods = await setModStatuses(device, changes, addLogEvent);
                let allSuccesful = true;
                updatedMods.forEach(m => {
                    if(m.id in changes && m.is_enabled !== changes[m.id]) {
                        allSuccesful = false;
                    }
                })
                setMods(updatedMods);

                if(!allSuccesful) {
                    setError("Not all the selected mods were successfully installed/uninstalled."
                    + "\nThis happens when two changes are made that conflict, e.g. trying to install a mod but uninstall one of its dependencies.");
                }
            }   catch(e) {
                setError(String(e));
            }  finally {
                setWorking(false);
            }
        }}>Sync Changes</button>}

		<div className="mod-list">
			{mods.map(mod => <ModCard
				gameVersion={gameVersion}
				mod={mod}
				key={mod.id}
				onRemoved={async () => {
					setWorking(true);
					try {
						setMods(await removeMod(device, mod.id, addLogEvent));
					}   catch(e) {
						setError(String(e));
					}   finally {
						setWorking(false);
					}
				}}
				onEnabledChanged={enabled => {
					const newChanges = { ...changes };
					newChanges[mod.id] = enabled;
					setChanges(newChanges);
				}}/>
			)}
		</div>
    </div>
}

function UploadButton({ onUploaded }: { onUploaded: (files: File[]) => void}) {
    const inputFile = useRef<HTMLInputElement | null>(null);
    return <button id="uploadButton" onClick={() => inputFile.current?.click()} title="Upload any .QMOD file, any song as a .ZIP, any Qosmetics files or any other file accepted by a particular mod.">
        Upload Files
        <img src={UploadIcon}/>
        <input type="file"
            id="file"
            multiple={true}
            ref={inputFile}
            style={{display: 'none'}}
            onChange={ev => {
                const files = ev.target.files;
                if(files !== null) {
                    onUploaded(Array.from(files));
                }
                ev.target.value = "";
            }}
        />
    </button>
}


type ImportType = "Url" | "File";
interface QueuedImport {
    type: ImportType
}

interface QueuedFileImport extends QueuedImport {
    file: File,
    type: "File"
}

interface QueuedUrlImport extends QueuedImport {
    url: string,
    type: "Url"
}

const importQueue: QueuedImport[] = [];
let isProcessingQueue: boolean = false;

function AddModsMenu(props: ModMenuProps) {
    const {
        mods,
        setMods,
        gameVersion,
        setWorking,
        setError,
        addLogEvent,
        device
    } = props;

    // Automatically installs a mod when it is imported, or warns the user if it isn't designed for the current game version.
    // Gives appropriate toasts/reports errors in each case.
    async function onModImported(result: ImportedMod) {
        const { installed_mods, imported_id } = result;
        setMods(installed_mods);

        const imported_mod = installed_mods.find(mod => mod.id === imported_id)!;
        const versionMismatch = imported_mod.game_version !== null &&gameVersion !== imported_mod.game_version;
        if(versionMismatch) {
            // Don't install a mod by default if its version mismatches: we want the user to understand the consequences
            setError("The mod `" + imported_id + "` was not enabled automatically as it is not designed for game version v" + trimGameVersion(gameVersion) + ".");
        }   else    {
            setMods(await setModStatuses(device, { [imported_id]: true }, addLogEvent));
            toast.success("Successfully downloaded and installed " + imported_id + " v" + imported_mod.version)
        }
    }

    // Processes an ImportResult
    async function onImportResult(importResult: ImportResult) {
        const filename = importResult.used_filename;
        const typedResult = importResult.result;
        if(typedResult.type === 'ImportedFileCopy') {
            logInfo(addLogEvent, "Successfully copied " + filename + " to " + typedResult.copied_to + " due to request from " + typedResult.mod_id);
            toast.success("Successfully copied " + filename + " to the path specified by " + typedResult.mod_id);
        }   else if(typedResult.type === 'ImportedSong') {
            toast.success("Successfully imported song " + filename);
        }   else    {
            await onModImported(typedResult);
        }
    }

    async function handleFileImport(file: File) {
        try {
            const importResult = await importFile(device, file, addLogEvent);
            await onImportResult(importResult);
        }   catch(e)   {
            toast.error("Failed to import file: " + e);
        }
    }

    async function handleUrlImport(url: string) {
        if (url.startsWith("file:///")) {
            toast.error("Cannot process dropped file from this source, drag from the file picker instead. (Drag from OperaGX file downloads popup does not work)");
            return;
        }
        try {
            const importResult = await importUrl(device, url, addLogEvent)
            await onImportResult(importResult);
        }   catch(e)   {
            toast.error(`Failed to import file: ${e}`);
        }
    }

    async function enqueueImports(imports: QueuedImport[]) {
        // Add the new imports to the queue
        importQueue.push(...imports);
        // If somebody else is processing the queue already, stop and let them finish processing the whole queue.
        if(isProcessingQueue) {
            return;
        }
        
        // Otherwise, we must stop being lazy and process the queue ourselves.
        console.log("Now processing import queue");
        isProcessingQueue = true;

        let disconnected = false;
        device.disconnected.then(() => disconnected = true);
        setWorking(true);
        while(importQueue.length > 0 && !disconnected) {
            // Process the next import, depending on if it is a URL or file
            const newImport = importQueue.pop()!;
            if(newImport.type == "File") {
                const file = (newImport as QueuedFileImport).file;
                await handleFileImport(file);
            }   else    {
                const url = (newImport as QueuedUrlImport).url;
                await handleUrlImport(url);
            }
        }
        setWorking(false);
        isProcessingQueue = false;
    }

    const { isDragging } = useFileDropper({
        onFilesDropped: async files => {
            enqueueImports(files.map(file => {
                return { type: "File", file: file };
            }))
        },
        onUrlDropped: async url => {
            const urlImport: QueuedUrlImport = {
                type: "Url",
                url: url
            };
            enqueueImports([urlImport])
        }
    })

    return <div className="verticalCenter">
        <Modal isVisible={isDragging}>
            <div className="horizontalCenter">
                <img src={UploadIcon}/>
                <h1>Drag 'n' drop files or links!</h1>
            </div>
        </Modal>

        <UploadButton onUploaded={async files => await enqueueImports(files.map(file => {
                return { type: "File", file: file };
            }))} />

        <ModRepoBrowser existingMods={mods} gameVersion={gameVersion} onDownload={async url => {
            setWorking(true);
            try {
                await onImportResult(await importUrl(device, url, addLogEvent));
            }   catch(e) { 
                setError("Failed to install mod " + e);
            }   finally {
                setWorking(false);
            }
        }} />
    </div>
}


function sortById(mods: Mod[]) {
    mods.sort((a, b) => {
        if(a.id > b.id) {
            return 1;
        }   else if(a.id < b.id) {
            return -1;
        }   else    {
            return 0;
        }
    })
}
