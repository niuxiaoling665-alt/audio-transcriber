import os
import time
import warnings
import pandas as pd
import speech_recognition as sr
import streamlit as st
from pydub import AudioSegment

# ==========================================
# 1. 环境配置 (适配云端 Linux / 本地通用环境)
# ==========================================
# 移除写死的 Windows E 盘路径，改用系统环境变量默认查找
warnings.filterwarnings("ignore", category=RuntimeWarning, module='pydub.utils')


# ==========================================
# 2. 核心语音识别与声道分离函数
# ==========================================
def process_single_audio(file_bytes, filename, recognizer):
    """处理单个音频流并返回识别结果"""
    start_time = time.time()
    left_text = ""
    right_text = ""
    status = "成功"
    error_msg = ""

    # 使用时间戳生成纯净的临时文件名
    safe_name = f"{int(time.time() * 1000)}"
    temp_input = f"temp_in_{safe_name}_{filename}"
    temp_mono = f"temp_mono_{safe_name}.wav"
    left_wav = f"temp_left_{safe_name}.wav"
    right_wav = f"temp_right_{safe_name}.wav"

    try:
        # 将上传的 Bytes 写入临时文件
        with open(temp_input, "wb") as f:
            f.write(file_bytes)

        audio = AudioSegment.from_file(temp_input)

        # 检查是否为双声道
        if audio.channels < 2:
            status = "部分识别"
            error_msg = "原文件为单声道，无法分离左右声道，仅识别主轨道。"
            audio.export(temp_mono, format="wav")
            with sr.AudioFile(temp_mono) as source:
                audio_data = recognizer.record(source)
                left_text = recognizer.recognize_google(audio_data, language='zh-CN')
        else:
            # 声道分离
            left_channel, right_channel = audio.split_to_mono()

            # 识别左声道
            left_channel.export(left_wav, format="wav")
            with sr.AudioFile(left_wav) as source:
                audio_left_data = recognizer.record(source)
                try:
                    left_text = recognizer.recognize_google(audio_left_data, language='zh-CN')
                except Exception:
                    left_text = "[无法识别或静音]"

            # 识别右声道
            right_channel.export(right_wav, format="wav")
            with sr.AudioFile(right_wav) as source:
                audio_right_data = recognizer.record(source)
                try:
                    right_text = recognizer.recognize_google(audio_right_data, language='zh-CN')
                except Exception:
                    right_text = "[无法识别或静音]"

    except Exception as e:
        status = "失败"
        error_msg = str(e)

    finally:
        # 清理临时文件
        for f in [temp_input, temp_mono, left_wav, right_wav]:
            if os.path.exists(f):
                try:
                    os.remove(f)
                except:
                    pass

    return {
        "文件名": filename,
        "左声道文本(坐席)": left_text,
        "right_text": right_text,
        "总耗时(s)": round(time.time() - start_time, 2),
        "状态": status,
        "错误信息": error_msg
    }


# ==========================================
# 3. Streamlit 网页布局
# ==========================================
st.set_page_config(layout="wide", page_title="录音分声道转文字系统")

st.title("🎙️ 录音批量转文字与声道分离系统")
st.caption("支持双声道音频的左右声道独立识别（左声道-坐席 / 右声道-客户）")
st.write("---")

left_col, right_col = st.columns([1, 2], gap="large")

with left_col:
    st.subheader("📁 1. 配置与上传")

    allowed_formats = st.multiselect(
        "选择支持的音频格式：",
        options=["mp3", "wav", "m4a", "flac"],
        default=["mp3", "wav"]
    )

    uploaded_files = st.file_uploader(
        "点击或拖拽音频文件到此处（支持多选）",
        type=allowed_formats,
        accept_multiple_files=True
    )

    if uploaded_files:
        st.info(f"已选中 {len(uploaded_files)} 个音频文件。")

    start_btn = st.button("🚀 开始批量转换识别", type="primary", disabled=not uploaded_files)

with right_col:
    st.subheader("📊 2. 转换结果")

    status_box = st.empty()
    progress_bar = st.empty()
    table_placeholder = st.empty()
    download_placeholder = st.empty()

    if start_btn and uploaded_files:
        recognizer = sr.Recognizer()
        results = []

        status_box.markdown("⏳ **正在初始化语音识别引擎...**")
        progress_bar.progress(0.0)

        total_files = len(uploaded_files)

        for idx, file in enumerate(uploaded_files):
            status_box.markdown(f"🔄 **正在处理 ({idx + 1}/{total_files}):** `{file.name}` ...")
            file_bytes = file.read()
            res = process_single_audio(file_bytes, file.name, recognizer)

            res["右声道文本(客户)"] = res.pop("right_text")
            ordered_res = {
                "文件名": res["文件名"],
                "左声道文本(坐席)": res["左声道文本(坐席)"],
                "右声道文本(客户)": res["右声道文本(客户)"],
                "总耗时(s)": res["总耗时(s)"],
                "状态": res["状态"],
                "错误信息": res["错误信息"]
            }

            results.append(ordered_res)

            df_current = pd.DataFrame(results)
            table_placeholder.dataframe(df_current, use_container_width=True)
            progress_bar.progress((idx + 1) / total_files)

        status_box.success("🎉 所有文件处理完毕！")

        df_final = pd.DataFrame(results)
        output_excel_name = "网页版_线索录音分声道识别结果.xlsx"
        df_final.to_excel(output_excel_name, index=False)

        with open(output_excel_name, "rb") as f:
            excel_bytes = f.read()

        download_placeholder.download_button(
            label="📥 下载识别结果 (Excel)",
            data=excel_bytes,
            file_name=output_excel_name,
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )

        if os.path.exists(output_excel_name):
            os.remove(output_excel_name)

    elif not uploaded_files:
        table_placeholder.info("等待上传文件并点击“开始批量转换识别”...")