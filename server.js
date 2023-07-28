// app.js

const express = require('express');
require('dotenv').config();
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const mongoose = require('mongoose');
const session = require('express-session');
const findOrCreate = require("mongoose-findorcreate");
require('dotenv').config();
const axios = require("axios");
const { google } = require("googleapis");
const openai = require('openai');

const cron = require('node-cron');

const openaiApiKey = process.env.openaiApiKey;


// Replace the following with your MongoDB connection string
const mongoURI = 'mongodb://127.0.0.1:27017/gmail-inbox';

const app = express();

// Connect to MongoDB
mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.log(err));

// Create a User schema
const UserSchema = new mongoose.Schema({
  googleId: String,
  accessToken: String,
  refreshToken: String,
});

const User = mongoose.model('User', UserSchema);

UserSchema.plugin(findOrCreate);



// Set up Passport.js
app.use(session({ secret: 'your-secret-key', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());



passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});


passport.use(new GoogleStrategy({
  clientID: process.env.clientID,
  clientSecret: process.env.clientSecret,
  callbackURL: 'http://localhost:3000/auth/google/callback',
  userProfileURL: 'https://www.googleapis.com/oauth2/v3/userinfo'
},
  (accessToken, refreshToken, profile, done) => {
    // Save or update the user data in the database
    User.findOrCreate(
      { googleId: profile.id },
      { accessToken, refreshToken },
      { upsert: true, new: true },
      (err, user) => {
        return done(err, user);
      }
    );
  }));



// Authentication route
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.compose'] })
);

// Callback route
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => {
   
    res.json("Authenticated Succesfully");
  });

  async function sendEmailReply(emailData, recipient, modelOutput, oauth2Client) {
    try {
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  
      const rawEmail = [
        `From: ${emailData.senderEmail}`,
        `To: ${recipient}`,
        `Subject: Re: ${emailData.subject}`,
        ``,
        `${modelOutput}`, // The model's output (reply) goes here
      ].join('\n');
  
      const encodedEmail = Buffer.from(rawEmail)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
  
      await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedEmail,
        },
      });
  
      console.log('Reply sent successfully!');
    } catch (error) {
      console.error('Error sending reply:', error);
    }
  }
  
  
  // Function to mark an email as read
  async function markEmailAsRead(gmail, emailId) {
    try {
      await gmail.users.messages.modify({
        userId: 'me',
        id: emailId,
        requestBody: {
          removeLabelIds: ['UNREAD'],
        },
      });
      console.log('Email marked as read:', emailId);
    } catch (error) {
      console.error('Error marking email as read:', error);
    }
  }
  
  cron.schedule('*/2 * * * *', async () => {
    try {
      // Retrieve all users from the database
      const users = await User.find();
  
      // Loop through each user and process their inbox
      for (const user of users) {
        // Use the user's access token to fetch inbox data from Gmail API
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({
          access_token: user.accessToken,
          refresh_token: user.refreshToken,
        });
  
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  
        // Fetch the user's most recent email (you can modify the search query as needed)
        const response = await gmail.users.messages.list({
          userId: 'me',
          maxResults: 1,
          q: 'is:unread in:inbox category:primary after:2023/07/20 -from:noreply -from:no-reply*', // Modify the search query to fetch unread emails in the inbox
        });
  
        if (response.data.messages && response.data.messages.length > 0) {
          // Get the ID of the most recent email
          const emailId = response.data.messages[0].id;
  
          // Fetch the content of the most recent email
          const emailContent = await gmail.users.messages.get({
            userId: 'me',
            id: emailId,
            format: 'full',
          });
  
          const senderHeader = emailContent.data.payload.headers.find(header => header.name === 'From').value;
          const [name, email] = senderHeader.match(/(.+?) <(.+?)>/).slice(1);
  
          const emailData = {
            senderName: name.trim(),
            senderEmail: email.trim(),
            subject: emailContent.data.payload.headers.find(header => header.name === 'Subject').value,
            body: emailContent.data.snippet,
          };
  
          const prompt = `Sender Name: ${emailData.senderName}\nSender Email: ${emailData.senderEmail}\nSubject: ${emailData.subject}\nBody: ${emailData.body}`;
  
          // Make the API call to the OpenAI server
          const openaiUrl = 'https://api.openai.com/v1/engines/text-davinci-002/completions';
  
          const openaiParams = {
            prompt: prompt,
            max_tokens: 100, // Adjust as needed
          };
          const openaiHeaders = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openaiApiKey}`,
          };
  
          const openaiResponse = await axios.post(openaiUrl, openaiParams, { headers: openaiHeaders });
  
          // The response from the OpenAI API containing the model's output
          const modelOutput = openaiResponse.data.choices[0].text;
  
  
          const recipient = emailData.senderEmail;
          await sendEmailReply(emailData, recipient, modelOutput, oauth2Client);
  
          console.log('Reply sent successfully to:', emailData.senderEmail);
          await markEmailAsRead(gmail, emailId);
        }
      }
    } catch (error) {
      console.error('Error processing email:', error);
    }
  });





const port = 3000;
app.listen(port, () => {
  console.log(`Server started on http://localhost:${port}`);
})