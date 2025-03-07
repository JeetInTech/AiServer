const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
const FormData = require('form-data');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');

// Load environment variables
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;  // Your Gemini API key
const HF_API_KEY = process.env.HF_API_KEY;  // Hugging Face API key
const HF_TEXT_MODEL = 'mistralai/Mistral-7B-Instruct-v0.2';  // More powerful LLM for text
const HF_IMAGE_MODEL = 'stabilityai/stable-diffusion-xl-base-1.0';  // High-quality SDXL for images
const FALLBACK_IMAGE_MODEL = 'stabilityai/sdxl-turbo';  // Fast fallback with decent quality

const LINKEDIN_AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const REDIRECT_URI = process.env.LINKEDIN_REDIRECT_URI || 'http://localhost:5001/auth/linkedin/callback';

// Retry function with exponential backoff
async function retryRequest(url, data, headers, retries = 5, initialDelay = 1, responseType = 'json') {
  let delay = initialDelay;
  
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.post(url, data, { 
        headers, 
        timeout: 60000,
        responseType: responseType === 'arraybuffer' ? 'arraybuffer' : 'json'
      });
      
      if (responseType === 'arraybuffer') {
        return response.data;
      } else {
        return response.data;
      }
    } catch (error) {
      if (error.response && error.response.status === 503 && i < retries - 1) {
        console.log(`Retrying (${i + 1}/${retries}) after 503 error, waiting ${delay}s...`);
        await new Promise(resolve => setTimeout(resolve, delay * 1000));
        delay *= 2;
        continue;
      }
      throw error;
    }
  }
}

// LinkedIn Authentication Routes
app.get('/auth/linkedin', (req, res) => {
  // Updated scope without w_organization_social
  const authUrl = `${LINKEDIN_AUTH_URL}?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=openid%20profile%20email%20w_member_social`;
  res.redirect(authUrl);
});

app.get('/auth/linkedin/callback', async (req, res) => {
  const error = req.query.error;
  if (error) {
    if (error === 'unauthorized_scope_error') {
      return res.status(400).json({
        error: 'unauthorized_scope_error',
        message: 'A requested scope is not authorized. Please check your app settings in the LinkedIn Developer Portal.'
      });
    }
    return res.status(400).json({ error, message: 'Authentication failed' });
  }

  const code = req.query.code;
  if (!code) {
    return res.status(400).json({ error: 'No code provided' });
  }
  
  try {
    const formData = new FormData();
    formData.append('grant_type', 'authorization_code');
    formData.append('code', code);
    formData.append('redirect_uri', REDIRECT_URI);
    formData.append('client_id', CLIENT_ID);
    formData.append('client_secret', CLIENT_SECRET);
    
    const response = await axios.post(LINKEDIN_TOKEN_URL, formData, {
      headers: {
        ...formData.getHeaders()
      }
    });
    
    const accessToken = response.data.access_token;
    res.redirect(`http://localhost:3000?token=${accessToken}`);
  } catch (error) {
    console.log(`Auth error: ${error.message}`);
    res.status(500).json({ error: 'Authentication failed', details: error.message });
  }
});

// Generate LinkedIn Post
app.post('/generate-post', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  // Enhanced Gemini prompt with stricter requirements
  const geminiPrompt = (
    `Create a professional LinkedIn post about '${prompt}' with these requirements:\n` +
    "- Length: 200-280 characters (MUST meet this)\n" +
    "- Include 1-3 relevant emojis (e.g., 🤝, 😊, 🚀, ❤️, MUST include at least one)\n" +
    "- Add 2-3 unique, industry-specific hashtags (no repetition, e.g., #Sales #LinkedIn #Growth, MUST include at least two)\n" +
    "- Structure: Engaging opening, valuable insight, clear call-to-action\n" +
    "- Tone: Professional but approachable\n" +
    "- Format: Just the post text, no additional explanations or markdown\n" +
    "- Ensure strict adherence to all requirements"
  );

  try {
    const geminiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{ text: geminiPrompt }]
        }]
      },
      { timeout: 15000 }
    );
    
    const postText = geminiResponse.data.candidates[0].content.parts[0].text.trim();
    console.log(`Gemini generated post: '${postText}'`);
    
    const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}]/u;
    console.log(`Length: ${postText.length}, Emojis: ${emojiPattern.test(postText)}, Hashtags: ${(postText.match(/#/g) || []).length}`);
    
    return handlePostValidation(postText, res);
  } catch (error) {
    console.log(`Gemini error: ${error.message}. Falling back to Hugging Face...`);
    return generateWithHuggingFace(prompt, res);
  }
});

function handlePostValidation(postText, res) {
  // Clean up text
  let cleanText = postText.replace(/\*\*|__|(\[.*?\])/g, '').trim();
  
  // Add missing emojis if needed
  const emojiCandidates = ['🚀', '💡', '👔', '🌍', '📈', '🤝', '🎯', '💼'];
  const emojiPattern = /[\u{1F600}-\u{1F6FF}]/u;
  
  if (!emojiPattern.test(cleanText)) {
    cleanText = `${emojiCandidates[0]} ${cleanText}`;
  }
  
  // Add hashtags if missing
  if ((cleanText.match(/#/g) || []).length < 2) {
    const hashtags = ['ProfessionalGrowth', 'CareerDevelopment', 'IndustryInsights'];
    cleanText += ` #${hashtags[0]} #${hashtags[1]}`;  // Add two hashtags if less than 2
  }
  
  // Ensure length
  if (cleanText.length > 280) {
    cleanText = cleanText.substring(0, 275) + '...';
  }
  
  // Final validation check
  if (!isValidPost(cleanText)) {
    console.log(`Validation failed after enhancement: '${cleanText}'`);
    return res.status(400).json({
      error: 'Post still doesn\'t meet requirements after enhancement',
      post: cleanText
    });
  }
  
  return res.json({ post: cleanText });
}

async function generateWithHuggingFace(prompt, res) {
  // Enhanced prompt for Hugging Face with stricter requirements
  const hfPrompt = (
    `[INST]Generate a professional LinkedIn post about '${prompt}'. ` +
    "Requirements:\n" +
    "- 200-280 characters (MUST meet this)\n" +
    "- 1-3 relevant emojis (use 🤝, 😊, 🚀, ❤️, MUST include at least one)\n" +
    "- 2-3 unique hashtags (no repetition, e.g., #Sales #LinkedIn #Growth, MUST include at least two)\n" +
    "- Professional, approachable tone\n" +
    "- Engaging opening, valuable insight, clear call-to-action\n" +
    "- No additional explanations or markdown\n" +
    "Example format:\n" +
    "Excited about [topic]! 🚀 Gain insights & connect. #Networking #Growth #Professional [/INST]"
  );
  
  const hfHeaders = {
    'Authorization': `Bearer ${HF_API_KEY}`,
    'Content-Type': 'application/json'
  };

  try {
    const response = await retryRequest(
      `https://api-inference.huggingface.co/models/${HF_TEXT_MODEL}`,
      {
        inputs: hfPrompt,
        parameters: {
          max_new_tokens: 300,
          temperature: 0.7,
          repetition_penalty: 1.5,
          do_sample: true,
          return_full_text: false
        }
      },
      hfHeaders
    );

    let postText = response[0]?.generated_text?.trim() || '';
    if (postText.includes('[/INST]')) {
      postText = postText.split('[/INST]')[1].trim();
    }
    
    console.log(`Hugging Face generated post: '${postText}'`);
    
    const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}]/u;
    console.log(`Length: ${postText.length}, Emojis: ${emojiPattern.test(postText)}, Hashtags: ${(postText.match(/#/g) || []).length}`);
    
    return handlePostValidation(postText, res);
  } catch (error) {
    console.log(`Hugging Face error: ${error.message}`);
    return res.status(503).json({
      error: 'Failed to generate post',
      details: error.message,
      post: "Excited about new opportunities! 🚀 Connect & grow together. #Networking #Growth #Professional"
    });
  }
}

function isValidPost(text) {
  if (!text) {
    return false;
  }
  // Adjust length to match prompt (200-280)
  if (text.length < 200 || text.length > 300) {  // Allow slight overflow
    return false;
  }
  // Check for at least one emoji using Unicode emoji detection
  const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/u;
  if (!emojiPattern.test(text)) {
    return false;
  }
  return true;
}

// Generate Image (Enhanced with SDXL and fallback)
app.post('/generate-image', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  let description;
  try {
    // Use Gemini to generate a detailed, high-quality image prompt
    const imagePrompt = (
      `Create a detailed prompt for a LinkedIn post image about '${prompt}'. ` +
      `Visual style: Corporate, modern, vibrant colors. Avoid text or logos. ` +
      `Focus on: Abstract concepts, professional growth, or industry-specific visuals.`
    );
    
    const geminiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{ text: imagePrompt }]
        }]
      },
      { timeout: 15000 }
    );
    
    description = geminiResponse.data.candidates[0].content.parts[0].text.trim();
  } catch (error) {
    console.log(`Gemini error: ${error.message}. Falling back to original prompt.`);
    description = prompt;
  }

  // Fallback to Hugging Face image generation with optimized SDXL parameters
  const hfHeaders = {
    'Authorization': `Bearer ${HF_API_KEY}`,
    'Content-Type': 'application/json'
  };

  let imageResponse;
  try {
    // Use SDXL base 1.0 for high quality
    imageResponse = await retryRequest(
      `https://api-inference.huggingface.co/models/${HF_IMAGE_MODEL}`,
      {
        inputs: description,
        parameters: {
          negative_prompt: 'blurry, lowres, text, watermark, disfigured, amateurish',
          num_inference_steps: 30,
          guidance_scale: 7.5,
          width: 1024,
          height: 1024,
          enhance_prompt: true
        }
      },
      hfHeaders,
      5,
      1,
      'arraybuffer'
    );
  } catch (error) {
    console.log(`Primary image model failed: ${error.message}. Switching to fallback...`);
    try {
      // Use SDXL-Turbo as fallback with optimized parameters
      const fallbackResponse = await axios.post(
        `https://api-inference.huggingface.co/models/${FALLBACK_IMAGE_MODEL}`,
        {
          inputs: description,
          parameters: {
            num_inference_steps: 10,
            guidance_scale: 5.0,
            width: 1024,
            height: 1024
          }
        },
        {
          headers: hfHeaders,
          timeout: 60000,
          responseType: 'arraybuffer'
        }
      );
      imageResponse = fallbackResponse.data;
    } catch (fallbackError) {
      console.log(`Fallback image model also failed: ${fallbackError.message}`);
      return res.status(503).json({
        imageUrl: 'https://via.placeholder.com/1024x1024.png?text=Image+Generation+Failed'
      });
    }
  }

  // Validate image
  try {
    // Using sharp to validate the image data
    await sharp(imageResponse).metadata();
    
    const base64Image = Buffer.from(imageResponse).toString('base64');
    const imageUrl = `data:image/png;base64,${base64Image}`;
    return res.json({ imageUrl });
  } catch (error) {
    console.log(`Invalid image: ${error.message}`);
    return res.status(503).json({
      imageUrl: 'https://via.placeholder.com/1024x1024.png?text=Image+Generation+Failed'
    });
  }
});

// Post to LinkedIn
app.post('/post-to-linkedin', async (req, res) => {
  const { token, post, imageUrl } = req.body;

  if (!token || !post) {
    return res.status(400).json({ error: 'Token and post content are required' });
  }

  try {
    // Add LinkedIn API version header
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0'
    };

    // Get user info
    const userInfoResponse = await axios.get('https://api.linkedin.com/v2/userinfo', { headers });
    const personUrn = `urn:li:person:${userInfoResponse.data.sub}`;

    // Prepare post data
    const postData = {
      author: personUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: post },
          shareMediaCategory: imageUrl && !imageUrl.includes('placeholder') ? 'IMAGE' : 'NONE',
        },
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
    };

    // Handle image upload if present
    if (imageUrl && !imageUrl.includes('placeholder')) {
      try {
        // Register upload
        const registerResponse = await axios.post(
          'https://api.linkedin.com/v2/assets?action=registerUpload',
          {
            registerUploadRequest: {
              recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
              owner: personUrn,
              serviceRelationships: [{
                relationshipType: 'OWNER', 
                identifier: 'urn:li:userGeneratedContent'
              }]
            }
          },
          { headers }
        );
        
        const uploadUrl = registerResponse.data.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
        const assetUrn = registerResponse.data.value.asset;

        // Upload image
        const imageData = Buffer.from(imageUrl.split(',')[1], 'base64');
        await axios.put(uploadUrl, imageData, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'image/png'
          }
        });

        // Add media to post
        postData.specificContent['com.linkedin.ugc.ShareContent'].media = [
          {
            status: 'READY',
            description: { text: 'Generated Image' },
            media: assetUrn,
            title: { text: 'Image Title' }
          }
        ];
      } catch (error) {
        console.log(`Image upload failed: ${error.message}`);
        postData.specificContent['com.linkedin.ugc.ShareContent'].shareMediaCategory = 'NONE';
      }
    }

    // Post to LinkedIn
    const response = await axios.post('https://api.linkedin.com/v2/ugcPosts', postData, { headers });
    return res.json({ success: true, postId: response.headers['x-restli-id'] });
  } catch (error) {
    console.log(`LinkedIn posting error: ${error.message}`);
    return res.status(500).json({ error: 'Failed to post to LinkedIn', details: error.message });
  }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
