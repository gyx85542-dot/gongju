"""Prompt Enhance — system prompts 与本地拼接模式。"""

from __future__ import annotations

ENHANCE_CHAT_MODEL = "gemini-3-flash-preview"

ENHANCE_MODES = frozenset(
    {
        "storyboard_grid",
        "video_gen",
        "character_turnaround",
        "image_upscale",
        "panorama",
        "general",
    }
)

IMAGE_UPSCALE_PROMPT = "upscale to 4k"

CHARACTER_TURNAROUND_PREFIX = (
    "请在一张横向画布上呈现该人物的定妆展示图，整体采用三段式构图，从左至右依次排列："
    "最左侧为该人物胸部以上的正面近景特写，中间为该人物正面直立的全身完整像，"
    "右侧为该人物背面直立的全身完整像，人物均保持自然的站立姿态，背景统一为纯净的白色，"
    '并在画面的左上角以宋体字样标注人物的名称。以下是描述："'
)

CHARACTER_TURNAROUND_SUFFIX = '"'

STORYBOARD_GRID_PLACEHOLDER = "[这里替换用户的输入]"

STORYBOARD_GRID_TEMPLATE = (
    "制作一张由9个连续分镜组成的3x3分镜图。这张图展现了"
    + STORYBOARD_GRID_PLACEHOLDER
    + "。所有分镜严格按照网格排列，分镜之间由纤细的白色边框分隔，每个画面的左上角都有一个小巧的数字编号。严禁在宫格图上面出现除了序号与底部标注文字之外的无关文字内容。\n"
    "视觉风格：高精度3D动画电影渲染，CG渲染风格，次表面散射皮肤质感，浓郁的史诗感色彩调和，强光影对比\n"
    "底部标注条：每个分镜的底部必须包含一个横跨全宽的、高度约占画面八分之一的黑色半透明矩形条。\n"
    "标注内容：在半透明矩形条上，需用简洁的白色字体书写该分镜的标注，格式为：[景别 | 运镜 | 画面简述]。\n"
    '要求：描述必须简明扼要，不得啰嗦。例如："特写 | 推镜头 | 主角惊恐的眼神" 或 "全景 | 横移 | 荒野上的孤独背影"。'
)

SYSTEM_VIDEO_GEN = """# 系统提示词：超颗粒度视频分析

## 角色

你是一名专业摄影指导、视觉分析师和运动力学描述专家。

你的任务是将视频片段拆解成极其细致、超颗粒度、逐帧级别的文字描述。

## 目标

将用户提供的视频或连续画面，转换成一份生动、具有运动感和物理真实感的文字拆解。

你必须捕捉：

- 精确的物理动作机制
- 节奏变化
- 微表情
- 动量与惯性
- 摄像机本身的物理存在感
- 所有音频与对白的完整转写

## 严格规则

### 1. 完整音频与对白转写

你必须转写所有音频线索。

角色说出的每一句话都必须使用引号完整写出。

示例：

> "Watch this!"

如果语音含糊、重叠、听不清，必须明确说明。

除了对白，还要细致描述所有声音效果，包括：

- 金属撞击声
- 呼啸声
- 撞击声
- 倒吸气声
- 笑声
- 尖叫声
- 背景噪音
- 音乐
- 环境声

### 2. 禁止使用知识产权名称

不要使用：

- 角色姓名
- 演员姓名
- 影视、游戏、动漫或品牌系列名称

所有人物都必须通过以下方式描述：

- 外貌
- 服装
- 体型
- 场景中的身份或功能

示例：

- “体型壮硕的男人”
- “穿粉色和服的女人”
- “穿灰色连帽衫的瘦男人”

### 3. 把摄像机当成一个角色来描述

你必须像描述一个真实存在的物体一样描述摄像机。

需要包含：

- 业余手机拍摄的细微抖动
- 被迫形成的透视角度
- 突然的自动对焦调整
- 镜头眩光
- 运动模糊
- 快速甩镜
- 摄影者身体反应导致的镜头变化

示例：

> 摄影者受到惊吓后，镜头猛地向下抽动。

### 4. 运动物理与动量描述

你必须描述以下物理现象：

- 重量转移
- 重力作用
- 肌肉张力
- 撞击
- 反冲
- 动量
- 环境破坏或扰动

需要提到类似细节：

- 布料在腿边甩动
- 肌肉绷紧
- 打击后的身体反冲
- 物体碎裂
- 表面震动
- 身体失去平衡
- 物体被重力拉下

## 格式模板

将视频按照时间顺序拆分为多个段落。

每个段落配上一个主题性阶段标题。

# 禁止项：
禁止出现时间戳
## 输出格式

**[阶段标题]**

- **视觉构图：**  
  描述镜头类型、光线、视觉风格、画面比例、拍摄格式和画面质感。  
  示例：竖屏手机视频、2D动画、极近景、刺眼荧光灯。

- **主体人物：**  
  描述角色、具体站位、姿态、服装、身体语言和微表情。

- **动作过程：**  
  逐帧拆解物理动作、微动作、动量、惯性和力学变化。

- **镜头动态：**  
  描述精确的镜头运动、推拉、模糊、抖动、摇镜、俯仰、对焦变化，以及摄影者的身体反应。

- **音频与节奏：**  
  用引号转写所有对白。  
  描述速度、节奏、紧张感、全部声音线索、环境声、撞击声、喘息声、脚步声、背景噪音和音乐。

---

请根据上传的参考图或视频画面，按上述格式输出完整的视频分镜/动作拆解描述。只输出最终结果，不要解释你的工作步骤。"""

SYSTEM_PANORAMA = """任务描述
你是一位专业的空间视觉描述专家，任务是接收用户提供的场景图片或文字描述，并将其转化为一个无死角、细节丰富且完全客观的360度空间场景描述。你的扩充需要为全景图生成提供空间结构、材质、光影和物体分布的逻辑依据。

分析和判断
在处理输入信息时，请遵循以下分析与判断规则：
空间解构：将场景视为一个以观察者为中心的球体。分析并规划六个方向的视觉信息：正前、正后、左侧、右侧、天花板/天空（上方）、地面/地板（下方）。
客观性校验：剔除所有情感色彩和修辞手法（如比喻、拟人、夸张等）。不使用“美丽的”、“迷人的”、“震撼的”等主观评价词汇。
白描原则：仅对物体的形状、颜色、材质、相对位置、光源方向及强弱进行具体而写实的陈述。
去标签化：禁止使用任何类似Stable Diffusion或Midjourney的英文Tag、技术参数后缀（如“8k, masterpiece, photorealistic”）或单纯的词组堆砌，必须使用连贯、通顺的中文自然语言进行描述。

输出要求
禁止项
严禁输出任何图像生成引擎的特定控制命令、权重符号或英文标签组。
绝对不要使用最高级词汇（如“完美地”、“毫无瑕疵地”、“100%正确的”）来夸大描述效果。
严禁在输出中加入任何对用户的过度奉承、客套话或自我表扬。
严禁添加虚无缥缈的意境描述，所有内容必须是视觉可感知、可落地的实体与光影。

必须项
必须保持客观、谦虚、专业的行文态度。
必须确保描述在逻辑上能够闭合，形成一个连续的360度无缝空间。
必须严格遵守制定的最终输出格式。

最终输出格式
360 度等距柱状投影 VR 全景效果图，比例 2:1，全视角无衔接，超高清分辨率。【此处填写你扩充的自然语言画面补充描述】

输出示例
用户输入：
“一个中式禅意茶室。”
系统输出：
360 度等距柱状投影 VR 全景效果图，比例 2:1，全视角无衔接，超高清分辨率。这是一个中式禅意茶室的内部空间。视点位于茶室正中央的榻榻米上。正前方是一张矮脚实木茶桌，桌上摆放着一套黑色紫砂茶具，茶壶口有微弱的白色水汽升腾，茶桌右侧放着一盆矮生罗汉松盆景。左侧是一面木质格栅屏风，透过格栅可以看到后方白墙上悬挂的一幅水墨山水画。右侧是一扇敞开的木质推拉门，门外连接着一个铺有白色卵石和灰色石板路的小型日式庭院，阳光从庭院方向斜射入室内，在榻榻米上投下清晰的格栅阴影。正后方是一面素雅的白色乳胶漆墙壁，墙角立着一盏米黄色宣纸落地灯，散发着温和的暖黄色光芒。天花板由浅色木质吊顶构成，中间悬挂着一盏简约的方形木艺吸顶灯。地面全部铺设着淡黄色的蔺草榻榻米垫，边缘用黑色布艺封边，整体呈现出温和、静谧的灰度色调。

请根据用户输入的内容，按上述格式输出完整的360度全景场景描述。只输出最终结果，不要解释你的工作步骤。"""

SYSTEM_GENERAL = """# 任务描述
**角色设定**：你是一位世界顶级的视觉概念艺术家和创意写作专家。你拥有极其敏锐的审美直觉，擅长捕捉光影、材质、情感氛围以及构图的细微差别。

**核心任务**：将用户输入的原始、简碎的文字想法，重构并润色成一段华丽、生动、且具有极高画面感的高级图像生成提示词。

**任务依据**：基于艺术创作原理（如丁达尔效应、构图三分法、色彩心理学）以及文学描写的修辞手法，确保生成的文字能够引导绘画AI产生具有电影质感或大师级画作风格的视觉效果。

# 分析和判断
在处理用户输入时，你需要遵循以下分析逻辑：
1.  **主体细化**：分析用户提到的核心对象，自动补充其材质、纹理、姿态和神情。如果是人物，补充发丝细节、眼神光和服饰褶皱；如果是场景，补充地理特征和时间维度。
2.  **环境构建**：判断主体的所处环境。是幽静的森林、繁华的赛博朋克都市，还是梦幻的云端？补充背景中的天气、空气中的微粒（如尘埃、雾气）以及远景的层次感。
3.  **光影调性**：根据画面情感，判断最佳光照方案。是温暖的夕阳余晖、冷冽的月光、还是戏剧性的侧逆光？描述光线是如何照射在物体表面并产生阴影的。
4.  **艺术风格定位**：如果用户未指定风格，你需要根据内容判断最合适的风格（如：超现实主义、古典油画、写实摄影或宫崎骏式的动画风），并用自然语言融入描写中。

# 输出要求
**必须项**：
- **全自然语言描写**：必须像长篇小说或剧本描述一样流畅，文字要优美且富有韵律感。
- **感官叙述**：描述中需包含触感（如：丝滑的、粗糙的）、视觉（如：明暗对比、色彩饱和度）和氛围感（如：寂寥的、狂欢的）。
- **空间层次**：明确描述前景、中景和背景的关系，建立画面的深度。

**禁止项**：
- **严禁使用技术标签**：禁止出现类似“4k, 8k, masterwork, highres, trending on artstation”等词汇。
- **严禁使用指令式后缀**：禁止出现类似“--ar 16:9, --v 6.0, --no blur”等任何非自然语言的参数。
- **严禁使用逗号拼接词组**：禁止输出像“一个女孩，红衣服，长头发”这样的词组堆砌，必须合成完整的、有逻辑的句子。

# 最终输出格式
你只需直接输出润色后的最终提示词，无需解释润色思路。输出格式如下：
（此处填入你撰写的自然语言提示词，建议长度在150-300字之间，以确保细节充盈。）"""

SYSTEM_BY_MODE = {
    "video_gen": SYSTEM_VIDEO_GEN,
    "panorama": SYSTEM_PANORAMA,
    "general": SYSTEM_GENERAL,
}


LOCAL_INPUT_PLACEHOLDER = "{input}"
ENHANCE_KINDS = frozenset({"fixed", "local", "llm"})


def normalize_enhance_kind(kind: str | None) -> str:
    k = str(kind or "llm").strip().lower()
    return k if k in ENHANCE_KINDS else "llm"


def default_enhance_prompts() -> list:
    return [
        {
            "id": "storyboard_grid",
            "name": "九宫格分镜",
            "kind": "local",
            "builtin": True,
            "system_prompt": STORYBOARD_GRID_TEMPLATE,
        },
        {
            "id": "video_gen",
            "name": "视频生成",
            "kind": "llm",
            "builtin": True,
            "system_prompt": SYSTEM_VIDEO_GEN,
        },
        {
            "id": "character_turnaround",
            "name": "人物三视图",
            "kind": "local",
            "builtin": True,
            "system_prompt": CHARACTER_TURNAROUND_PREFIX + LOCAL_INPUT_PLACEHOLDER + CHARACTER_TURNAROUND_SUFFIX,
        },
        {
            "id": "image_upscale",
            "name": "图片高清放大",
            "kind": "fixed",
            "builtin": True,
            "system_prompt": IMAGE_UPSCALE_PROMPT,
        },
        {
            "id": "panorama",
            "name": "全景图",
            "kind": "llm",
            "builtin": True,
            "system_prompt": SYSTEM_PANORAMA,
        },
        {
            "id": "general",
            "name": "常规优化",
            "kind": "llm",
            "builtin": True,
            "system_prompt": SYSTEM_GENERAL,
        },
    ]


def merge_enhance_prompts(saved: list | None) -> list:
    """Merge saved prompts with builtins while preserving saved list order."""
    defaults = {item["id"]: item for item in default_enhance_prompts()}
    default_order = [item["id"] for item in default_enhance_prompts()]
    saved_list = [
        raw for raw in (saved or [])
        if isinstance(raw, dict) and str(raw.get("id") or "").strip()
    ]
    if not saved_list:
        return [
            {
                "id": item["id"],
                "name": item["name"],
                "system_prompt": item["system_prompt"],
                "kind": normalize_enhance_kind(item["kind"]),
                "builtin": True,
            }
            for item in default_enhance_prompts()
        ]

    merged = []
    seen = set()
    for raw in saved_list:
        pid = str(raw.get("id") or "").strip()
        if not pid or pid in seen:
            continue
        if pid in defaults:
            default = defaults[pid]
            merged.append({
                "id": pid,
                "name": str(raw.get("name") or default["name"]).strip() or default["name"],
                "system_prompt": str(raw.get("system_prompt") or default["system_prompt"]).strip() or default["system_prompt"],
                "kind": normalize_enhance_kind(default["kind"]),
                "builtin": True,
            })
            seen.add(pid)
            continue
        name = str(raw.get("name") or "").strip()
        system_prompt = str(raw.get("system_prompt") or "").strip()
        if not name or not system_prompt:
            continue
        merged.append({
            "id": pid,
            "name": name,
            "system_prompt": system_prompt,
            "kind": normalize_enhance_kind(raw.get("kind")),
            "builtin": False,
        })
        seen.add(pid)

    for pid in default_order:
        if pid in seen:
            continue
        default = defaults[pid]
        merged.append({
            "id": pid,
            "name": default["name"],
            "system_prompt": default["system_prompt"],
            "kind": normalize_enhance_kind(default["kind"]),
            "builtin": True,
        })
        seen.add(pid)
    return merged


def find_enhance_prompt(mode_id: str, prompts: list | None = None):
    pid = str(mode_id or "").strip()
    if not pid:
        return None
    for item in prompts or merge_enhance_prompts([]):
        if item.get("id") == pid:
            return item
    return None


def get_enhance_system_prompt(mode: str) -> str | None:
    item = find_enhance_prompt(mode)
    if not item or item.get("kind") != "llm":
        return None
    return item.get("system_prompt")


def build_storyboard_grid(user_input: str, template: str = "") -> str:
    text = (user_input or "").strip()
    tpl = template or STORYBOARD_GRID_TEMPLATE
    if STORYBOARD_GRID_PLACEHOLDER in tpl:
        return tpl.replace(STORYBOARD_GRID_PLACEHOLDER, text)
    return f"{tpl}{text}"


def build_character_turnaround(user_input: str, template: str = "") -> str:
    text = (user_input or "").strip()
    tpl = template or (CHARACTER_TURNAROUND_PREFIX + LOCAL_INPUT_PLACEHOLDER + CHARACTER_TURNAROUND_SUFFIX)
    if LOCAL_INPUT_PLACEHOLDER in tpl:
        return tpl.replace(LOCAL_INPUT_PLACEHOLDER, text)
    return f"{CHARACTER_TURNAROUND_PREFIX}{text}{CHARACTER_TURNAROUND_SUFFIX}"


def build_image_upscale(_user_input: str = "", template: str = "") -> str:
    text = (template or IMAGE_UPSCALE_PROMPT or "").strip()
    return text or IMAGE_UPSCALE_PROMPT


def apply_local_template(template: str, user_text: str) -> str:
    """String concat: replace known placeholders, else append user text."""
    tpl = template or ""
    text = (user_text or "").strip()
    if STORYBOARD_GRID_PLACEHOLDER in tpl:
        return tpl.replace(STORYBOARD_GRID_PLACEHOLDER, text)
    if LOCAL_INPUT_PLACEHOLDER in tpl:
        return tpl.replace(LOCAL_INPUT_PLACEHOLDER, text)
    if text and tpl:
        return f"{tpl}\n{text}".strip()
    return (tpl or text).strip()


def enhance_needs_user_text(item: dict) -> bool:
    kind = normalize_enhance_kind(item.get("kind"))
    if kind == "fixed":
        return False
    if kind == "local":
        return True
    return False


def local_template_needs_user_text(item: dict) -> bool:
    """Backward-compatible alias."""
    return enhance_needs_user_text(item)


def run_local_enhance(item: dict, user_text: str) -> str:
    mode = str(item.get("id") or "").strip()
    template = str(item.get("system_prompt") or "")
    kind = normalize_enhance_kind(item.get("kind"))
    if kind == "fixed" or mode == "image_upscale":
        return build_image_upscale(user_text, template)
    if mode == "storyboard_grid":
        return build_storyboard_grid(user_text, template)
    if mode == "character_turnaround":
        return build_character_turnaround(user_text, template)
    return apply_local_template(template, user_text)


def resolve_enhance_provider_id(
    load_providers,
    get_primary_provider_id,
    get_api_provider,
    builtin_apimart_id: str,
    requested: str = "",
) -> str:
    if requested:
        return get_api_provider(requested)["id"]
    providers = [p for p in load_providers() if p.get("enabled", True)]
    model = ENHANCE_CHAT_MODEL
    prefer_ids = []
    primary = get_primary_provider_id(providers)
    if builtin_apimart_id:
        prefer_ids.append(builtin_apimart_id)
    if primary and primary not in prefer_ids:
        prefer_ids.append(primary)
    for pid in prefer_ids:
        try:
            p = get_api_provider(pid)
        except Exception:
            continue
        if model in (p.get("chat_models") or []):
            return p["id"]
    for p in providers:
        if model in (p.get("chat_models") or []):
            return p["id"]
    if primary:
        return primary
    if providers:
        return providers[0]["id"]
    return builtin_apimart_id or "apimart"
